/**
 * Step 1 of the pipeline: normalize the source deck to a single PDF.
 *
 *   PDF      → copied through (no conversion needed)
 *   PPT/PPTX → LibreOffice headless (`soffice --convert-to pdf`)
 *
 * Each invocation uses a throwaway UserInstallation profile so concurrent runs
 * don't fight over LibreOffice's lock file. Missing LibreOffice surfaces as a
 * WorkerError with a friendly message — the worker degrades the job to `failed`,
 * the app stays up.
 */

import { copyFile, readFile } from "node:fs/promises";
import path from "node:path";
import { commandExists, run, WorkerError } from "./shell";

function libreOfficeBin(): string {
  return process.env.LIBREOFFICE_BIN || "soffice";
}

export interface ConvertResult {
  /** Path to the normalized PDF on disk. */
  pdfPath: string;
  /** Bytes of the converted PDF when we generated one (PPT/PPTX); null for a
   *  pass-through PDF (no need to re-store the original as a "preview"). */
  convertedPdfBytes: Uint8Array | null;
}

export async function convertToPdf(args: {
  inputPath: string;
  ext: "pdf" | "ppt" | "pptx";
  workDir: string;
}): Promise<ConvertResult> {
  const { inputPath, ext, workDir } = args;
  const outPdf = path.join(workDir, "deck.pdf");

  if (ext === "pdf") {
    await copyFile(inputPath, outPdf);
    return { pdfPath: outPdf, convertedPdfBytes: null };
  }

  // Resolve an available LibreOffice binary.
  const preferred = libreOfficeBin();
  let bin: string | null = null;
  if (await commandExists(preferred)) bin = preferred;
  else if (await commandExists("libreoffice")) bin = "libreoffice";
  if (!bin) {
    throw new WorkerError(
      "LibreOffice (soffice/libreoffice) not installed",
      "Preview tools are unavailable on the server."
    );
  }

  const profileDir = path.join(workDir, "lo-profile");
  await run(
    bin,
    [
      "--headless",
      "--norestore",
      "--nolockcheck",
      "--nodefault",
      `-env:UserInstallation=file://${profileDir}`,
      "--convert-to",
      "pdf",
      "--outdir",
      workDir,
      inputPath,
    ],
    { timeoutMs: 180_000 }
  );

  // LibreOffice writes <inputBasename>.pdf into outdir.
  const produced = path.join(workDir, `${path.basename(inputPath, path.extname(inputPath))}.pdf`);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(produced));
  } catch {
    throw new WorkerError(
      `LibreOffice produced no PDF for ${inputPath}`,
      "We couldn't convert that presentation."
    );
  }
  await copyFile(produced, outPdf);
  return { pdfPath: outPdf, convertedPdfBytes: bytes };
}
