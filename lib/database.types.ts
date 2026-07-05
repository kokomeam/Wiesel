export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      agent_findings: {
        Row: {
          change_set_id: string | null
          course_id: string
          created_at: string
          dedupe_key: string
          finding: Json
          id: string
          kind: string
          run_id: string | null
          severity: string
          status: string
          updated_at: string
        }
        Insert: {
          change_set_id?: string | null
          course_id: string
          created_at?: string
          dedupe_key: string
          finding: Json
          id?: string
          kind: string
          run_id?: string | null
          severity: string
          status?: string
          updated_at?: string
        }
        Update: {
          change_set_id?: string | null
          course_id?: string
          created_at?: string
          dedupe_key?: string
          finding?: Json
          id?: string
          kind?: string
          run_id?: string | null
          severity?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_findings_change_set_id_fkey"
            columns: ["change_set_id"]
            isOneToOne: false
            referencedRelation: "change_sets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_findings_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_findings_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "agent_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_runs: {
        Row: {
          budget_used: Json | null
          course_id: string
          created_at: string
          error: string | null
          finished_at: string | null
          id: string
          report: Json | null
          scope: Json | null
          started_at: string | null
          status: string
          trigger: string
        }
        Insert: {
          budget_used?: Json | null
          course_id: string
          created_at?: string
          error?: string | null
          finished_at?: string | null
          id?: string
          report?: Json | null
          scope?: Json | null
          started_at?: string | null
          status?: string
          trigger: string
        }
        Update: {
          budget_used?: Json | null
          course_id?: string
          created_at?: string
          error?: string | null
          finished_at?: string | null
          id?: string
          report?: Json | null
          scope?: Json | null
          started_at?: string | null
          status?: string
          trigger?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_runs_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
        ]
      }
      analytics_event: {
        Row: {
          anonymous_id: string | null
          campaign_id: string | null
          contact_id: string | null
          course_id: string
          created_at: string
          id: string
          landing_page_id: string | null
          occurred_at: string
          props: Json
          source: string | null
          subscriber_id: string | null
          type: string
        }
        Insert: {
          anonymous_id?: string | null
          campaign_id?: string | null
          contact_id?: string | null
          course_id: string
          created_at?: string
          id?: string
          landing_page_id?: string | null
          occurred_at?: string
          props?: Json
          source?: string | null
          subscriber_id?: string | null
          type: string
        }
        Update: {
          anonymous_id?: string | null
          campaign_id?: string | null
          contact_id?: string | null
          course_id?: string
          created_at?: string
          id?: string
          landing_page_id?: string | null
          occurred_at?: string
          props?: Json
          source?: string | null
          subscriber_id?: string | null
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "analytics_event_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "marketing_campaign"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "analytics_event_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "audience_contact"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "analytics_event_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "analytics_event_landing_page_id_fkey"
            columns: ["landing_page_id"]
            isOneToOne: false
            referencedRelation: "landing_page"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "analytics_event_subscriber_id_fkey"
            columns: ["subscriber_id"]
            isOneToOne: false
            referencedRelation: "subscriber"
            referencedColumns: ["id"]
          },
        ]
      }
      audience_contact: {
        Row: {
          attributes: Json
          author_id: string
          consent: Json
          created_at: string
          email: string
          id: string
          name: string | null
          unsubscribed_at: string | null
          updated_at: string
        }
        Insert: {
          attributes?: Json
          author_id: string
          consent?: Json
          created_at?: string
          email: string
          id?: string
          name?: string | null
          unsubscribed_at?: string | null
          updated_at?: string
        }
        Update: {
          attributes?: Json
          author_id?: string
          consent?: Json
          created_at?: string
          email?: string
          id?: string
          name?: string | null
          unsubscribed_at?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      blocks: {
        Row: {
          content: Json
          course_id: string
          created_at: string
          id: string
          lesson_id: string
          order: number
          title: string | null
          type: string
          updated_at: string
        }
        Insert: {
          content?: Json
          course_id: string
          created_at?: string
          id?: string
          lesson_id: string
          order?: number
          title?: string | null
          type: string
          updated_at?: string
        }
        Update: {
          content?: Json
          course_id?: string
          created_at?: string
          id?: string
          lesson_id?: string
          order?: number
          title?: string | null
          type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "blocks_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "blocks_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lessons"
            referencedColumns: ["id"]
          },
        ]
      }
      change_set_items: {
        Row: {
          after: Json | null
          before: Json | null
          block_id: string | null
          change_set_id: string
          course_id: string
          created_at: string
          evidence: Json | null
          id: string
          lesson_id: string | null
          node_id: string | null
          node_type: string
          op: string
        }
        Insert: {
          after?: Json | null
          before?: Json | null
          block_id?: string | null
          change_set_id: string
          course_id: string
          created_at?: string
          evidence?: Json | null
          id?: string
          lesson_id?: string | null
          node_id?: string | null
          node_type?: string
          op: string
        }
        Update: {
          after?: Json | null
          before?: Json | null
          block_id?: string | null
          change_set_id?: string
          course_id?: string
          created_at?: string
          evidence?: Json | null
          id?: string
          lesson_id?: string | null
          node_id?: string | null
          node_type?: string
          op?: string
        }
        Relationships: [
          {
            foreignKeyName: "change_set_items_change_set_id_fkey"
            columns: ["change_set_id"]
            isOneToOne: false
            referencedRelation: "change_sets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "change_set_items_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
        ]
      }
      change_sets: {
        Row: {
          conversation_id: string | null
          course_id: string
          created_at: string
          id: string
          lesson_id: string | null
          message_id: string | null
          resolved_at: string | null
          status: string
          summary: string | null
          updated_at: string
        }
        Insert: {
          conversation_id?: string | null
          course_id: string
          created_at?: string
          id?: string
          lesson_id?: string | null
          message_id?: string | null
          resolved_at?: string | null
          status?: string
          summary?: string | null
          updated_at?: string
        }
        Update: {
          conversation_id?: string | null
          course_id?: string
          created_at?: string
          id?: string
          lesson_id?: string | null
          message_id?: string | null
          resolved_at?: string | null
          status?: string
          summary?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "change_sets_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "change_sets_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "change_sets_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lessons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "change_sets_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
        ]
      }
      conversations: {
        Row: {
          course_id: string
          created_at: string
          id: string
          lesson_id: string | null
          title: string | null
          updated_at: string
        }
        Insert: {
          course_id: string
          created_at?: string
          id?: string
          lesson_id?: string | null
          title?: string | null
          updated_at?: string
        }
        Update: {
          course_id?: string
          created_at?: string
          id?: string
          lesson_id?: string | null
          title?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversations_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lessons"
            referencedColumns: ["id"]
          },
        ]
      }
      course_publications: {
        Row: {
          content_hash: string
          course_id: string
          created_by: string
          id: string
          linter_report: Json | null
          previous_slugs: string[]
          published_at: string
          slug: string
          snapshot: Json
          status: string
          version: number
          visibility: string
        }
        Insert: {
          content_hash: string
          course_id: string
          created_by: string
          id?: string
          linter_report?: Json | null
          previous_slugs?: string[]
          published_at?: string
          slug: string
          snapshot: Json
          status?: string
          version: number
          visibility?: string
        }
        Update: {
          content_hash?: string
          course_id?: string
          created_by?: string
          id?: string
          linter_report?: Json | null
          previous_slugs?: string[]
          published_at?: string
          slug?: string
          snapshot?: Json
          status?: string
          version?: number
          visibility?: string
        }
        Relationships: [
          {
            foreignKeyName: "course_publications_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
        ]
      }
      courses: {
        Row: {
          audience: string | null
          author_id: string
          created_at: string
          description: string | null
          id: string
          level: string | null
          plan: Json
          price_cents: number
          status: string
          tags: string[]
          theme: Json
          title: string
          updated_at: string
          visibility: string
        }
        Insert: {
          audience?: string | null
          author_id: string
          created_at?: string
          description?: string | null
          id?: string
          level?: string | null
          plan?: Json
          price_cents?: number
          status?: string
          tags?: string[]
          theme?: Json
          title: string
          updated_at?: string
          visibility?: string
        }
        Update: {
          audience?: string | null
          author_id?: string
          created_at?: string
          description?: string | null
          id?: string
          level?: string | null
          plan?: Json
          price_cents?: number
          status?: string
          tags?: string[]
          theme?: Json
          title?: string
          updated_at?: string
          visibility?: string
        }
        Relationships: []
      }
      deck_import_pages: {
        Row: {
          created_at: string
          deck_import_id: string
          height: number | null
          id: string
          image_path: string
          page_number: number
          thumbnail_path: string | null
          width: number | null
        }
        Insert: {
          created_at?: string
          deck_import_id: string
          height?: number | null
          id?: string
          image_path: string
          page_number: number
          thumbnail_path?: string | null
          width?: number | null
        }
        Update: {
          created_at?: string
          deck_import_id?: string
          height?: number | null
          id?: string
          image_path?: string
          page_number?: number
          thumbnail_path?: string | null
          width?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "deck_import_pages_deck_import_id_fkey"
            columns: ["deck_import_id"]
            isOneToOne: false
            referencedRelation: "deck_imports"
            referencedColumns: ["id"]
          },
        ]
      }
      deck_imports: {
        Row: {
          block_id: string | null
          course_id: string
          created_at: string
          error: string | null
          id: string
          lesson_id: string | null
          metadata: Json
          original_file_name: string
          original_file_path: string
          original_file_size: number
          original_mime_type: string
          owner_id: string
          page_count: number | null
          preview_pdf_path: string | null
          source_external_id: string | null
          source_type: string
          source_url: string | null
          status: string
          title: string
          updated_at: string
        }
        Insert: {
          block_id?: string | null
          course_id: string
          created_at?: string
          error?: string | null
          id?: string
          lesson_id?: string | null
          metadata?: Json
          original_file_name: string
          original_file_path: string
          original_file_size: number
          original_mime_type: string
          owner_id: string
          page_count?: number | null
          preview_pdf_path?: string | null
          source_external_id?: string | null
          source_type?: string
          source_url?: string | null
          status?: string
          title: string
          updated_at?: string
        }
        Update: {
          block_id?: string | null
          course_id?: string
          created_at?: string
          error?: string | null
          id?: string
          lesson_id?: string | null
          metadata?: Json
          original_file_name?: string
          original_file_path?: string
          original_file_size?: number
          original_mime_type?: string
          owner_id?: string
          page_count?: number | null
          preview_pdf_path?: string | null
          source_external_id?: string | null
          source_type?: string
          source_url?: string | null
          status?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "deck_imports_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
        ]
      }
      email_sequence: {
        Row: {
          campaign_id: string
          course_id: string
          created_at: string
          id: string
          kind: string
          name: string
          status: string
          trigger: Json
          updated_at: string
        }
        Insert: {
          campaign_id: string
          course_id: string
          created_at?: string
          id?: string
          kind: string
          name: string
          status?: string
          trigger?: Json
          updated_at?: string
        }
        Update: {
          campaign_id?: string
          course_id?: string
          created_at?: string
          id?: string
          kind?: string
          name?: string
          status?: string
          trigger?: Json
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "email_sequence_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "marketing_campaign"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "email_sequence_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
        ]
      }
      email_touch: {
        Row: {
          ai_rationale: string | null
          approval_status: string
          body: Json
          compliance_warnings: Json
          course_id: string
          created_at: string
          delay_seconds: number | null
          id: string
          personalization_variables: Json
          position: number
          preview_text: string | null
          purpose: string | null
          quality_score: Json | null
          sequence_id: string
          stage_name: string | null
          subject: string
          trigger_event: string | null
          updated_at: string
        }
        Insert: {
          ai_rationale?: string | null
          approval_status?: string
          body?: Json
          compliance_warnings?: Json
          course_id: string
          created_at?: string
          delay_seconds?: number | null
          id?: string
          personalization_variables?: Json
          position?: number
          preview_text?: string | null
          purpose?: string | null
          quality_score?: Json | null
          sequence_id: string
          stage_name?: string | null
          subject: string
          trigger_event?: string | null
          updated_at?: string
        }
        Update: {
          ai_rationale?: string | null
          approval_status?: string
          body?: Json
          compliance_warnings?: Json
          course_id?: string
          created_at?: string
          delay_seconds?: number | null
          id?: string
          personalization_variables?: Json
          position?: number
          preview_text?: string | null
          purpose?: string | null
          quality_score?: Json | null
          sequence_id?: string
          stage_name?: string | null
          subject?: string
          trigger_event?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "email_touch_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "email_touch_sequence_id_fkey"
            columns: ["sequence_id"]
            isOneToOne: false
            referencedRelation: "email_sequence"
            referencedColumns: ["id"]
          },
        ]
      }
      enrollments: {
        Row: {
          comms_opt_out: boolean
          course_id: string
          enrolled_at: string
          id: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          comms_opt_out?: boolean
          course_id: string
          enrolled_at?: string
          id?: string
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          comms_opt_out?: boolean
          course_id?: string
          enrolled_at?: string
          id?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "enrollments_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
        ]
      }
      follow_up_rule: {
        Row: {
          campaign_id: string
          course_id: string
          created_at: string
          delay_days: number
          email_touch_id: string | null
          id: string
          name: string
          status: string
          trigger: string
          updated_at: string
        }
        Insert: {
          campaign_id: string
          course_id: string
          created_at?: string
          delay_days?: number
          email_touch_id?: string | null
          id?: string
          name: string
          status?: string
          trigger: string
          updated_at?: string
        }
        Update: {
          campaign_id?: string
          course_id?: string
          created_at?: string
          delay_days?: number
          email_touch_id?: string | null
          id?: string
          name?: string
          status?: string
          trigger?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "follow_up_rule_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "marketing_campaign"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "follow_up_rule_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "follow_up_rule_email_touch_id_fkey"
            columns: ["email_touch_id"]
            isOneToOne: false
            referencedRelation: "email_touch"
            referencedColumns: ["id"]
          },
        ]
      }
      homework_submissions: {
        Row: {
          block_id: string
          content: Json
          course_id: string
          created_at: string
          file_paths: string[]
          id: string
          publication_id: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          block_id: string
          content: Json
          course_id: string
          created_at?: string
          file_paths?: string[]
          id?: string
          publication_id: string
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          block_id?: string
          content?: Json
          course_id?: string
          created_at?: string
          file_paths?: string[]
          id?: string
          publication_id?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "homework_submissions_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "homework_submissions_publication_id_fkey"
            columns: ["publication_id"]
            isOneToOne: false
            referencedRelation: "course_publications"
            referencedColumns: ["id"]
          },
        ]
      }
      landing_page: {
        Row: {
          campaign_id: string
          course_id: string
          created_at: string
          id: string
          published_at: string | null
          sections: Json
          slug: string
          status: string
          theme: Json
          title: string
          updated_at: string
        }
        Insert: {
          campaign_id: string
          course_id: string
          created_at?: string
          id?: string
          published_at?: string | null
          sections?: Json
          slug: string
          status?: string
          theme?: Json
          title: string
          updated_at?: string
        }
        Update: {
          campaign_id?: string
          course_id?: string
          created_at?: string
          id?: string
          published_at?: string | null
          sections?: Json
          slug?: string
          status?: string
          theme?: Json
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "landing_page_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "marketing_campaign"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "landing_page_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
        ]
      }
      lead_list: {
        Row: {
          campaign_id: string | null
          consent_confirmed: boolean
          course_id: string
          created_at: string
          id: string
          name: string
          source_type: string
          updated_at: string
        }
        Insert: {
          campaign_id?: string | null
          consent_confirmed?: boolean
          course_id: string
          created_at?: string
          id?: string
          name: string
          source_type?: string
          updated_at?: string
        }
        Update: {
          campaign_id?: string | null
          consent_confirmed?: boolean
          course_id?: string
          created_at?: string
          id?: string
          name?: string
          source_type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "lead_list_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "marketing_campaign"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_list_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
        ]
      }
      lead_list_member: {
        Row: {
          added_at: string
          list_id: string
          subscriber_id: string
        }
        Insert: {
          added_at?: string
          list_id: string
          subscriber_id: string
        }
        Update: {
          added_at?: string
          list_id?: string
          subscriber_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "lead_list_member_list_id_fkey"
            columns: ["list_id"]
            isOneToOne: false
            referencedRelation: "lead_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_list_member_subscriber_id_fkey"
            columns: ["subscriber_id"]
            isOneToOne: false
            referencedRelation: "subscriber"
            referencedColumns: ["id"]
          },
        ]
      }
      learn_progress: {
        Row: {
          course_id: string
          created_at: string
          id: string
          last_activity_at: string
          lesson_id: string
          pct: number
          progress_state: Json
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          course_id: string
          created_at?: string
          id?: string
          last_activity_at?: string
          lesson_id: string
          pct?: number
          progress_state?: Json
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          course_id?: string
          created_at?: string
          id?: string
          last_activity_at?: string
          lesson_id?: string
          pct?: number
          progress_state?: Json
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "learn_progress_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
        ]
      }
      learner_flags: {
        Row: {
          computed_at: string
          course_id: string
          detail: Json
          flag_type: string
          user_id: string
        }
        Insert: {
          computed_at?: string
          course_id: string
          detail?: Json
          flag_type: string
          user_id: string
        }
        Update: {
          computed_at?: string
          course_id?: string
          detail?: Json
          flag_type?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "learner_flags_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
        ]
      }
      learner_messages: {
        Row: {
          body: Json
          channel: string
          course_id: string
          created_at: string
          error: string | null
          finding_id: string | null
          id: string
          provider_message_id: string | null
          sent_at: string | null
          status: string
          subject: string
          updated_at: string
          user_id: string
        }
        Insert: {
          body: Json
          channel?: string
          course_id: string
          created_at?: string
          error?: string | null
          finding_id?: string | null
          id?: string
          provider_message_id?: string | null
          sent_at?: string | null
          status?: string
          subject: string
          updated_at?: string
          user_id: string
        }
        Update: {
          body?: Json
          channel?: string
          course_id?: string
          created_at?: string
          error?: string | null
          finding_id?: string | null
          id?: string
          provider_message_id?: string | null
          sent_at?: string | null
          status?: string
          subject?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "learner_messages_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "learner_messages_finding_id_fkey"
            columns: ["finding_id"]
            isOneToOne: false
            referencedRelation: "agent_findings"
            referencedColumns: ["id"]
          },
        ]
      }
      learning_events: {
        Row: {
          attempt_id: string | null
          block_id: string | null
          client_event_id: string
          client_ts: string
          course_id: string
          dwell_ms: number | null
          event_type: string
          id: string
          lesson_id: string
          metadata: Json
          publication_id: string
          quartile: number | null
          server_ts: string
          slide_id: string | null
          user_id: string
          version: number
        }
        Insert: {
          attempt_id?: string | null
          block_id?: string | null
          client_event_id: string
          client_ts: string
          course_id: string
          dwell_ms?: number | null
          event_type: string
          id?: string
          lesson_id: string
          metadata?: Json
          publication_id: string
          quartile?: number | null
          server_ts?: string
          slide_id?: string | null
          user_id: string
          version: number
        }
        Update: {
          attempt_id?: string | null
          block_id?: string | null
          client_event_id?: string
          client_ts?: string
          course_id?: string
          dwell_ms?: number | null
          event_type?: string
          id?: string
          lesson_id?: string
          metadata?: Json
          publication_id?: string
          quartile?: number | null
          server_ts?: string
          slide_id?: string | null
          user_id?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "learning_events_attempt_id_fkey"
            columns: ["attempt_id"]
            isOneToOne: false
            referencedRelation: "quiz_attempts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "learning_events_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "learning_events_publication_id_fkey"
            columns: ["publication_id"]
            isOneToOne: false
            referencedRelation: "course_publications"
            referencedColumns: ["id"]
          },
        ]
      }
      lessons: {
        Row: {
          course_id: string
          created_at: string
          estimated_minutes: number | null
          id: string
          module_id: string
          objective: string | null
          order: number
          title: string
          updated_at: string
        }
        Insert: {
          course_id: string
          created_at?: string
          estimated_minutes?: number | null
          id?: string
          module_id: string
          objective?: string | null
          order?: number
          title: string
          updated_at?: string
        }
        Update: {
          course_id?: string
          created_at?: string
          estimated_minutes?: number | null
          id?: string
          module_id?: string
          objective?: string | null
          order?: number
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "lessons_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lessons_module_id_fkey"
            columns: ["module_id"]
            isOneToOne: false
            referencedRelation: "modules"
            referencedColumns: ["id"]
          },
        ]
      }
      marketing_action: {
        Row: {
          action_kind: string
          autonomy_decision: Json | null
          before_snapshot: Json | null
          campaign_id: string | null
          course_id: string
          created_at: string
          id: string
          params: Json
          requested_by: string
          resolved_at: string | null
          reversibility: string
          revert_expires_at: string | null
          status: string
          summary: string | null
          target_ref: Json | null
          tool_name: string
          updated_at: string
        }
        Insert: {
          action_kind: string
          autonomy_decision?: Json | null
          before_snapshot?: Json | null
          campaign_id?: string | null
          course_id: string
          created_at?: string
          id?: string
          params?: Json
          requested_by?: string
          resolved_at?: string | null
          reversibility: string
          revert_expires_at?: string | null
          status?: string
          summary?: string | null
          target_ref?: Json | null
          tool_name: string
          updated_at?: string
        }
        Update: {
          action_kind?: string
          autonomy_decision?: Json | null
          before_snapshot?: Json | null
          campaign_id?: string | null
          course_id?: string
          created_at?: string
          id?: string
          params?: Json
          requested_by?: string
          resolved_at?: string | null
          reversibility?: string
          revert_expires_at?: string | null
          status?: string
          summary?: string | null
          target_ref?: Json | null
          tool_name?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "marketing_action_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "marketing_campaign"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "marketing_action_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
        ]
      }
      marketing_autonomy_settings: {
        Row: {
          course_id: string
          created_at: string
          id: string
          mode: string
          policy: Json
          revert_window_hours: number
          updated_at: string
        }
        Insert: {
          course_id: string
          created_at?: string
          id?: string
          mode?: string
          policy?: Json
          revert_window_hours?: number
          updated_at?: string
        }
        Update: {
          course_id?: string
          created_at?: string
          id?: string
          mode?: string
          policy?: Json
          revert_window_hours?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "marketing_autonomy_settings_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: true
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
        ]
      }
      marketing_campaign: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          compliance_report: Json
          compliance_status: string
          config: Json
          course_id: string
          created_at: string
          goal: string | null
          id: string
          lead_list_id: string | null
          name: string
          sender_identity_id: string | null
          status: string
          updated_at: string
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          compliance_report?: Json
          compliance_status?: string
          config?: Json
          course_id: string
          created_at?: string
          goal?: string | null
          id?: string
          lead_list_id?: string | null
          name: string
          sender_identity_id?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          compliance_report?: Json
          compliance_status?: string
          config?: Json
          course_id?: string
          created_at?: string
          goal?: string | null
          id?: string
          lead_list_id?: string | null
          name?: string
          sender_identity_id?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "marketing_campaign_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "marketing_campaign_lead_list_fkey"
            columns: ["lead_list_id"]
            isOneToOne: false
            referencedRelation: "lead_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "marketing_campaign_sender_identity_fkey"
            columns: ["sender_identity_id"]
            isOneToOne: false
            referencedRelation: "sender_identity"
            referencedColumns: ["id"]
          },
        ]
      }
      marketing_question: {
        Row: {
          answer: Json | null
          campaign_id: string | null
          conversation_id: string | null
          course_id: string
          created_at: string
          id: string
          options: Json
          question: string
          requested_by: string
          resolved_at: string | null
          source: string
          status: string
          tool_call_id: string | null
          tool_name: string | null
          tool_params: Json | null
          updated_at: string
        }
        Insert: {
          answer?: Json | null
          campaign_id?: string | null
          conversation_id?: string | null
          course_id: string
          created_at?: string
          id?: string
          options?: Json
          question: string
          requested_by?: string
          resolved_at?: string | null
          source: string
          status?: string
          tool_call_id?: string | null
          tool_name?: string | null
          tool_params?: Json | null
          updated_at?: string
        }
        Update: {
          answer?: Json | null
          campaign_id?: string | null
          conversation_id?: string | null
          course_id?: string
          created_at?: string
          id?: string
          options?: Json
          question?: string
          requested_by?: string
          resolved_at?: string | null
          source?: string
          status?: string
          tool_call_id?: string | null
          tool_name?: string | null
          tool_params?: Json | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "marketing_question_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "marketing_campaign"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "marketing_question_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "marketing_question_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
        ]
      }
      marketing_segment_send: {
        Row: {
          campaign_id: string | null
          course_id: string
          created_at: string
          first_sent_at: string
          id: string
          last_sent_at: string
          segment_key: string
          send_count: number
          updated_at: string
        }
        Insert: {
          campaign_id?: string | null
          course_id: string
          created_at?: string
          first_sent_at?: string
          id?: string
          last_sent_at?: string
          segment_key: string
          send_count?: number
          updated_at?: string
        }
        Update: {
          campaign_id?: string | null
          course_id?: string
          created_at?: string
          first_sent_at?: string
          id?: string
          last_sent_at?: string
          segment_key?: string
          send_count?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "marketing_segment_send_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "marketing_campaign"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "marketing_segment_send_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
        ]
      }
      messages: {
        Row: {
          content: Json
          conversation_id: string
          course_id: string
          created_at: string
          id: string
          role: string
        }
        Insert: {
          content?: Json
          conversation_id: string
          course_id: string
          created_at?: string
          id?: string
          role: string
        }
        Update: {
          content?: Json
          conversation_id?: string
          course_id?: string
          created_at?: string
          id?: string
          role?: string
        }
        Relationships: [
          {
            foreignKeyName: "messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
        ]
      }
      modules: {
        Row: {
          course_id: string
          created_at: string
          description: string | null
          id: string
          order: number
          title: string
          updated_at: string
        }
        Insert: {
          course_id: string
          created_at?: string
          description?: string | null
          id?: string
          order?: number
          title: string
          updated_at?: string
        }
        Update: {
          course_id?: string
          created_at?: string
          description?: string | null
          id?: string
          order?: number
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "modules_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          display_name: string | null
          id: string
          plan: string
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          id: string
          plan?: string
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          id?: string
          plan?: string
          updated_at?: string
        }
        Relationships: []
      }
      question_responses: {
        Row: {
          attempt_id: string
          correct: boolean
          id: string
          question_id: string
          response: Json
          time_ms: number | null
        }
        Insert: {
          attempt_id: string
          correct: boolean
          id?: string
          question_id: string
          response: Json
          time_ms?: number | null
        }
        Update: {
          attempt_id?: string
          correct?: boolean
          id?: string
          question_id?: string
          response?: Json
          time_ms?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "question_responses_attempt_id_fkey"
            columns: ["attempt_id"]
            isOneToOne: false
            referencedRelation: "quiz_attempts"
            referencedColumns: ["id"]
          },
        ]
      }
      quiz_answer_keys: {
        Row: {
          block_id: string
          created_at: string
          keys: Json
          publication_id: string
        }
        Insert: {
          block_id: string
          created_at?: string
          keys: Json
          publication_id: string
        }
        Update: {
          block_id?: string
          created_at?: string
          keys?: Json
          publication_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "quiz_answer_keys_publication_id_fkey"
            columns: ["publication_id"]
            isOneToOne: false
            referencedRelation: "course_publications"
            referencedColumns: ["id"]
          },
        ]
      }
      quiz_attempts: {
        Row: {
          attempt_number: number
          block_id: string
          course_id: string
          id: string
          max_score: number
          publication_id: string
          score: number
          started_at: string
          submitted_at: string
          user_id: string
          version: number
        }
        Insert: {
          attempt_number: number
          block_id: string
          course_id: string
          id?: string
          max_score: number
          publication_id: string
          score: number
          started_at?: string
          submitted_at?: string
          user_id: string
          version: number
        }
        Update: {
          attempt_number?: number
          block_id?: string
          course_id?: string
          id?: string
          max_score?: number
          publication_id?: string
          score?: number
          started_at?: string
          submitted_at?: string
          user_id?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "quiz_attempts_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quiz_attempts_publication_id_fkey"
            columns: ["publication_id"]
            isOneToOne: false
            referencedRelation: "course_publications"
            referencedColumns: ["id"]
          },
        ]
      }
      rollup_lesson_funnel: {
        Row: {
          completed_count: number
          computed_at: string
          course_id: string
          dropoff_pct: number | null
          lesson_id: string
          lesson_order: number
          publication_id: string
          started_count: number
          version: number
        }
        Insert: {
          completed_count?: number
          computed_at?: string
          course_id: string
          dropoff_pct?: number | null
          lesson_id: string
          lesson_order: number
          publication_id: string
          started_count?: number
          version: number
        }
        Update: {
          completed_count?: number
          computed_at?: string
          course_id?: string
          dropoff_pct?: number | null
          lesson_id?: string
          lesson_order?: number
          publication_id?: string
          started_count?: number
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "rollup_lesson_funnel_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rollup_lesson_funnel_publication_id_fkey"
            columns: ["publication_id"]
            isOneToOne: false
            referencedRelation: "course_publications"
            referencedColumns: ["id"]
          },
        ]
      }
      rollup_question_stats: {
        Row: {
          answer_distribution: Json
          block_id: string
          computed_at: string
          course_id: string
          discrimination: number | null
          key_value: string | null
          lesson_id: string
          n: number
          pct_correct: number | null
          publication_id: string
          question_id: string
          version: number
        }
        Insert: {
          answer_distribution?: Json
          block_id: string
          computed_at?: string
          course_id: string
          discrimination?: number | null
          key_value?: string | null
          lesson_id: string
          n?: number
          pct_correct?: number | null
          publication_id: string
          question_id: string
          version: number
        }
        Update: {
          answer_distribution?: Json
          block_id?: string
          computed_at?: string
          course_id?: string
          discrimination?: number | null
          key_value?: string | null
          lesson_id?: string
          n?: number
          pct_correct?: number | null
          publication_id?: string
          question_id?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "rollup_question_stats_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rollup_question_stats_publication_id_fkey"
            columns: ["publication_id"]
            isOneToOne: false
            referencedRelation: "course_publications"
            referencedColumns: ["id"]
          },
        ]
      }
      rollup_slide_dwell: {
        Row: {
          block_id: string
          computed_at: string
          course_id: string
          lesson_id: string
          median_dwell_ms: number | null
          n: number
          p90_dwell_ms: number | null
          publication_id: string
          slide_id: string
          version: number
        }
        Insert: {
          block_id: string
          computed_at?: string
          course_id: string
          lesson_id: string
          median_dwell_ms?: number | null
          n?: number
          p90_dwell_ms?: number | null
          publication_id: string
          slide_id: string
          version: number
        }
        Update: {
          block_id?: string
          computed_at?: string
          course_id?: string
          lesson_id?: string
          median_dwell_ms?: number | null
          n?: number
          p90_dwell_ms?: number | null
          publication_id?: string
          slide_id?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "rollup_slide_dwell_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rollup_slide_dwell_publication_id_fkey"
            columns: ["publication_id"]
            isOneToOne: false
            referencedRelation: "course_publications"
            referencedColumns: ["id"]
          },
        ]
      }
      rollup_video_retention: {
        Row: {
          block_id: string
          completed_count: number
          computed_at: string
          course_id: string
          lesson_id: string
          publication_id: string
          q1_count: number
          q2_count: number
          q3_count: number
          q4_count: number
          version: number
          viewers: number
        }
        Insert: {
          block_id: string
          completed_count?: number
          computed_at?: string
          course_id: string
          lesson_id: string
          publication_id: string
          q1_count?: number
          q2_count?: number
          q3_count?: number
          q4_count?: number
          version: number
          viewers?: number
        }
        Update: {
          block_id?: string
          completed_count?: number
          computed_at?: string
          course_id?: string
          lesson_id?: string
          publication_id?: string
          q1_count?: number
          q2_count?: number
          q3_count?: number
          q4_count?: number
          version?: number
          viewers?: number
        }
        Relationships: [
          {
            foreignKeyName: "rollup_video_retention_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rollup_video_retention_publication_id_fkey"
            columns: ["publication_id"]
            isOneToOne: false
            referencedRelation: "course_publications"
            referencedColumns: ["id"]
          },
        ]
      }
      scheduled_send: {
        Row: {
          action_id: string | null
          attempts: number
          bounce_type: string | null
          course_id: string
          created_at: string
          error: string | null
          id: string
          provider_message_id: string | null
          scheduled_for: string
          sent_at: string | null
          sequence_id: string | null
          soft_bounce_count: number
          status: string
          subscriber_id: string
          touch_id: string | null
          updated_at: string
        }
        Insert: {
          action_id?: string | null
          attempts?: number
          bounce_type?: string | null
          course_id: string
          created_at?: string
          error?: string | null
          id?: string
          provider_message_id?: string | null
          scheduled_for?: string
          sent_at?: string | null
          sequence_id?: string | null
          soft_bounce_count?: number
          status?: string
          subscriber_id: string
          touch_id?: string | null
          updated_at?: string
        }
        Update: {
          action_id?: string | null
          attempts?: number
          bounce_type?: string | null
          course_id?: string
          created_at?: string
          error?: string | null
          id?: string
          provider_message_id?: string | null
          scheduled_for?: string
          sent_at?: string | null
          sequence_id?: string | null
          soft_bounce_count?: number
          status?: string
          subscriber_id?: string
          touch_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "scheduled_send_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scheduled_send_sequence_id_fkey"
            columns: ["sequence_id"]
            isOneToOne: false
            referencedRelation: "email_sequence"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scheduled_send_subscriber_id_fkey"
            columns: ["subscriber_id"]
            isOneToOne: false
            referencedRelation: "subscriber"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scheduled_send_touch_id_fkey"
            columns: ["touch_id"]
            isOneToOne: false
            referencedRelation: "email_touch"
            referencedColumns: ["id"]
          },
        ]
      }
      sender_identity: {
        Row: {
          business_name: string | null
          course_id: string
          created_at: string
          from_email: string
          from_name: string
          id: string
          mailing_address: string
          reply_to: string | null
          updated_at: string
          verified: boolean
        }
        Insert: {
          business_name?: string | null
          course_id: string
          created_at?: string
          from_email: string
          from_name: string
          id?: string
          mailing_address: string
          reply_to?: string | null
          updated_at?: string
          verified?: boolean
        }
        Update: {
          business_name?: string | null
          course_id?: string
          created_at?: string
          from_email?: string
          from_name?: string
          id?: string
          mailing_address?: string
          reply_to?: string | null
          updated_at?: string
          verified?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "sender_identity_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
        ]
      }
      sequence_enrollment: {
        Row: {
          completed_at: string | null
          course_id: string
          created_at: string
          current_position: number
          id: string
          sequence_id: string
          started_at: string
          status: string
          subscriber_id: string
          updated_at: string
        }
        Insert: {
          completed_at?: string | null
          course_id: string
          created_at?: string
          current_position?: number
          id?: string
          sequence_id: string
          started_at?: string
          status?: string
          subscriber_id: string
          updated_at?: string
        }
        Update: {
          completed_at?: string | null
          course_id?: string
          created_at?: string
          current_position?: number
          id?: string
          sequence_id?: string
          started_at?: string
          status?: string
          subscriber_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "sequence_enrollment_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sequence_enrollment_sequence_id_fkey"
            columns: ["sequence_id"]
            isOneToOne: false
            referencedRelation: "email_sequence"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sequence_enrollment_subscriber_id_fkey"
            columns: ["subscriber_id"]
            isOneToOne: false
            referencedRelation: "subscriber"
            referencedColumns: ["id"]
          },
        ]
      }
      subscriber: {
        Row: {
          anonymous_id: string | null
          attributes: Json
          campaign_id: string | null
          consent: Json
          consent_requested_at: string | null
          consent_status: string
          contact_id: string | null
          course_id: string
          created_at: string
          email: string
          id: string
          name: string | null
          source: string | null
          status: string
          unsubscribed_at: string | null
          updated_at: string
        }
        Insert: {
          anonymous_id?: string | null
          attributes?: Json
          campaign_id?: string | null
          consent?: Json
          consent_requested_at?: string | null
          consent_status?: string
          contact_id?: string | null
          course_id: string
          created_at?: string
          email: string
          id?: string
          name?: string | null
          source?: string | null
          status?: string
          unsubscribed_at?: string | null
          updated_at?: string
        }
        Update: {
          anonymous_id?: string | null
          attributes?: Json
          campaign_id?: string | null
          consent?: Json
          consent_requested_at?: string | null
          consent_status?: string
          contact_id?: string | null
          course_id?: string
          created_at?: string
          email?: string
          id?: string
          name?: string | null
          source?: string | null
          status?: string
          unsubscribed_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "subscriber_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "marketing_campaign"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "subscriber_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "audience_contact"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "subscriber_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
        ]
      }
      video_assets: {
        Row: {
          aspect_ratio: string | null
          block_id: string | null
          caption_error: string | null
          caption_language_code: string | null
          caption_source: string | null
          caption_status: string
          caption_track_id: string | null
          caption_track_name: string | null
          course_id: string
          created_at: string
          duration_seconds: number | null
          error: string | null
          id: string
          lesson_id: string | null
          metadata: Json
          mp4_status: string | null
          mp4_url: string | null
          mux_asset_id: string | null
          mux_playback_id: string | null
          mux_upload_id: string | null
          owner_id: string
          playback_policy: string
          provider: string
          status: string
          thumbnail_time: number | null
          transcript: string | null
          transcript_updated_at: string | null
          transcript_vtt: string | null
          updated_at: string
        }
        Insert: {
          aspect_ratio?: string | null
          block_id?: string | null
          caption_error?: string | null
          caption_language_code?: string | null
          caption_source?: string | null
          caption_status?: string
          caption_track_id?: string | null
          caption_track_name?: string | null
          course_id: string
          created_at?: string
          duration_seconds?: number | null
          error?: string | null
          id?: string
          lesson_id?: string | null
          metadata?: Json
          mp4_status?: string | null
          mp4_url?: string | null
          mux_asset_id?: string | null
          mux_playback_id?: string | null
          mux_upload_id?: string | null
          owner_id: string
          playback_policy?: string
          provider?: string
          status?: string
          thumbnail_time?: number | null
          transcript?: string | null
          transcript_updated_at?: string | null
          transcript_vtt?: string | null
          updated_at?: string
        }
        Update: {
          aspect_ratio?: string | null
          block_id?: string | null
          caption_error?: string | null
          caption_language_code?: string | null
          caption_source?: string | null
          caption_status?: string
          caption_track_id?: string | null
          caption_track_name?: string | null
          course_id?: string
          created_at?: string
          duration_seconds?: number | null
          error?: string | null
          id?: string
          lesson_id?: string | null
          metadata?: Json
          mp4_status?: string | null
          mp4_url?: string | null
          mux_asset_id?: string | null
          mux_playback_id?: string | null
          mux_upload_id?: string | null
          owner_id?: string
          playback_policy?: string
          provider?: string
          status?: string
          thumbnail_time?: number | null
          transcript?: string | null
          transcript_updated_at?: string | null
          transcript_vtt?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "video_assets_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
        ]
      }
      voice_profile: {
        Row: {
          author_id: string
          created_at: string
          id: string
          rules: Json
          updated_at: string
        }
        Insert: {
          author_id: string
          created_at?: string
          id?: string
          rules?: Json
          updated_at?: string
        }
        Update: {
          author_id?: string
          created_at?: string
          id?: string
          rules?: Json
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      course_analytics_overview: { Args: { cid: string }; Returns: Json }
      course_roster: {
        Args: { cid: string }
        Returns: {
          completed_lessons: number
          display_name: string
          email: string
          enrolled_at: string
          enrollment_status: string
          flags: Json
          last_activity_at: string
          progress_pct: number
          total_lessons: number
          user_id: string
        }[]
      }
      ingest_learning_events: { Args: { p_events: Json }; Returns: number }
      marketplace_listings: {
        Args: never
        Returns: {
          audience: string
          course_id: string
          creator_name: string
          description: string
          lesson_count: number
          level: string
          module_count: number
          publication_id: string
          published_at: string
          slug: string
          title: string
          version: number
        }[]
      }
      my_learning: {
        Args: never
        Returns: {
          completed_lessons: number
          course_id: string
          description: string
          enrolled_at: string
          enrollment_id: string
          enrollment_status: string
          last_activity_at: string
          level: string
          publication_id: string
          slug: string
          title: string
          total_lessons: number
          version: number
        }[]
      }
      publish_course: {
        Args: {
          p_answer_keys: Json
          p_content_hash: string
          p_course_id: string
          p_linter_report?: Json
          p_slug?: string
          p_snapshot: Json
          p_visibility?: string
        }
        Returns: Json
      }
      refresh_course_analytics: { Args: { cid: string }; Returns: undefined }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
