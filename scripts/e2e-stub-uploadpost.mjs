/**
 * Local Upload-Post stub for the AC-MD.8 live E2E — canned sync-success
 * responses in the vendor's verified shapes. ZERO vendor traffic: the dev
 * server points UPLOAD_POST_API_BASE here. Counts publishes at GET /__calls.
 */
import http from "node:http";

let publishCalls = 0;
const server = http.createServer((req, res) => {
  const url = req.url ?? "";
  res.setHeader("content-type", "application/json");
  if (url === "/__calls") {
    res.end(JSON.stringify({ publishCalls }));
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (url.startsWith("/api/upload_text") || url.startsWith("/api/upload")) {
      publishCalls++;
      res.end(
        JSON.stringify({
          success: true,
          request_id: `stub-req-${publishCalls}`,
          results: {
            linkedin: {
              success: true,
              platform_post_id: `urn:li:share:stub-${publishCalls}`,
              url: `https://www.linkedin.com/feed/update/urn:li:share:stub-${publishCalls}`,
            },
          },
          usage: { count: publishCalls, limit: 10 },
        })
      );
      return;
    }
    if (url.startsWith("/api/uploadposts/users") && req.method === "POST") {
      res.statusCode = 201;
      res.end(JSON.stringify({ success: true }));
      return;
    }
    if (url.startsWith("/api/uploadposts/users")) {
      res.end(JSON.stringify([]));
      return;
    }
    res.end(JSON.stringify({ success: true, history: [], results: [] }));
  });
});
server.listen(4949, () => console.log("upload-post stub on :4949"));
