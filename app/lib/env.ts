/**
 * 集中管理服务端环境变量。
 *
 * 使用懒 getter：校验推迟到首次读取时执行，不会在 import 阶段抛错。
 * 这样 CLI 脚本（ingest.ts）可以先加载 .env.local 再访问 env 变量。
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(
      `[env] 必需的环境变量缺失: ${name}\n` +
        `请确认 .env.local 已配置，或在运行 CLI 脚本前手动 export。`,
    );
  }
  return value;
}

export const env = {
  get SUPABASE_URL(): string {
    return required("NEXT_PUBLIC_SUPABASE_URL");
  },
  get SUPABASE_SERVICE_ROLE_KEY(): string {
    return required("SUPABASE_SERVICE_ROLE_KEY");
  },
} as const;
