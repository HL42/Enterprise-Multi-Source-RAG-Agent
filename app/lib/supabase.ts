import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "./env";

// Node.js 20 没有原生 WebSocket，Supabase realtime 需要它。
// 用 ws 做 polyfill；ingest 脚本只走 REST API，实际不会触发 WebSocket 连接。
if (typeof globalThis.WebSocket === "undefined") {
  try {
    const WebSocket = require("ws");
    (globalThis as any).WebSocket = WebSocket;
  } catch {
    // 如果 ws 未安装，Supabase 客户端在 Node 20 创建时会抛错
  }
}

/**
 * 服务端 Supabase 客户端（service_role key），具有绕过 RLS 的能力。
 * 仅用于服务端 API Route / Server Component / CLI 脚本，禁止在 client 组件 import。
 */

let cached: SupabaseClient | null = null;

export function getSupabaseAdmin(): SupabaseClient {
  if (!cached) {
    cached = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });
  }
  return cached;
}

export const supabase = getSupabaseAdmin();
