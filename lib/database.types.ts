/**
 * Supabase database types — GENERATED, do not edit by hand.
 *
 * Regenerate after any migration via the Supabase MCP `generate_typescript_types`
 * tool, or the CLI:
 *   supabase gen types typescript --project-id mfqolkzocxssgogcmhzf > lib/database.types.ts
 *
 * Reflects migrations: core_authoring_schema · harden_rls_and_advisors ·
 * course_plan · ai_agent_conversations_changesets · marketing_assistant ·
 * marketing_account_tier (audience_contact + subscriber/analytics_event.contact_id).
 */

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
          block_id: string
          change_set_id: string
          course_id: string
          created_at: string
          id: string
          lesson_id: string | null
          op: string
        }
        Insert: {
          after?: Json | null
          before?: Json | null
          block_id: string
          change_set_id: string
          course_id: string
          created_at?: string
          id?: string
          lesson_id?: string | null
          op: string
        }
        Update: {
          after?: Json | null
          before?: Json | null
          block_id?: string
          change_set_id?: string
          course_id?: string
          created_at?: string
          id?: string
          lesson_id?: string | null
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
          body: Json
          course_id: string
          created_at: string
          delay_seconds: number | null
          id: string
          position: number
          preview_text: string | null
          sequence_id: string
          subject: string
          trigger_event: string | null
          updated_at: string
        }
        Insert: {
          body?: Json
          course_id: string
          created_at?: string
          delay_seconds?: number | null
          id?: string
          position?: number
          preview_text?: string | null
          sequence_id: string
          subject: string
          trigger_event?: string | null
          updated_at?: string
        }
        Update: {
          body?: Json
          course_id?: string
          created_at?: string
          delay_seconds?: number | null
          id?: string
          position?: number
          preview_text?: string | null
          sequence_id?: string
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
          before_snapshot: Json | null
          campaign_id: string | null
          course_id: string
          created_at: string
          id: string
          params: Json
          requested_by: string
          resolved_at: string | null
          reversibility: string
          status: string
          summary: string | null
          target_ref: Json | null
          tool_name: string
          updated_at: string
        }
        Insert: {
          action_kind: string
          before_snapshot?: Json | null
          campaign_id?: string | null
          course_id: string
          created_at?: string
          id?: string
          params?: Json
          requested_by?: string
          resolved_at?: string | null
          reversibility: string
          status?: string
          summary?: string | null
          target_ref?: Json | null
          tool_name: string
          updated_at?: string
        }
        Update: {
          action_kind?: string
          before_snapshot?: Json | null
          campaign_id?: string | null
          course_id?: string
          created_at?: string
          id?: string
          params?: Json
          requested_by?: string
          resolved_at?: string | null
          reversibility?: string
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
      marketing_campaign: {
        Row: {
          config: Json
          course_id: string
          created_at: string
          goal: string | null
          id: string
          name: string
          status: string
          updated_at: string
        }
        Insert: {
          config?: Json
          course_id: string
          created_at?: string
          goal?: string | null
          id?: string
          name: string
          status?: string
          updated_at?: string
        }
        Update: {
          config?: Json
          course_id?: string
          created_at?: string
          goal?: string | null
          id?: string
          name?: string
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
      scheduled_send: {
        Row: {
          action_id: string | null
          attempts: number
          course_id: string
          created_at: string
          error: string | null
          id: string
          provider_message_id: string | null
          scheduled_for: string
          sent_at: string | null
          sequence_id: string | null
          status: string
          subscriber_id: string
          touch_id: string | null
          updated_at: string
        }
        Insert: {
          action_id?: string | null
          attempts?: number
          course_id: string
          created_at?: string
          error?: string | null
          id?: string
          provider_message_id?: string | null
          scheduled_for?: string
          sent_at?: string | null
          sequence_id?: string | null
          status?: string
          subscriber_id: string
          touch_id?: string | null
          updated_at?: string
        }
        Update: {
          action_id?: string | null
          attempts?: number
          course_id?: string
          created_at?: string
          error?: string | null
          id?: string
          provider_message_id?: string | null
          scheduled_for?: string
          sent_at?: string | null
          sequence_id?: string | null
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
          campaign_id: string
          consent: Json
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
          campaign_id: string
          consent?: Json
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
          campaign_id?: string
          consent?: Json
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
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
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
