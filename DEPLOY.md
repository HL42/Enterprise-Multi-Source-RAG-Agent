# 部署指南：Render.com 一键部署

## 为什么不用 Vercel？

Vercel 免费版 Serverless 函数硬限制 10 秒。这个项目用 `@xenova/transformers` 首次加载 `all-MiniLM-L6-v2` 模型需要下载 ~80MB（首次 20-40 秒），且 agent 工具调用往返可能超过 10 秒。**Render Web Service 是长期运行的 Node.js 进程，不限请求时长。** Embedding 模型加载一次，后续所有请求复用。

---

## 第一步：推送代码到 GitHub

```bash
git add render.yaml DEPLOY.md
git commit -m "Add Render deployment blueprint"
git push
```

## 第二步：Render 后台一键部署

1. 打开 [dashboard.render.com](https://dashboard.render.com) → 登录
2. 点击右上角 **New +** → **Blueprint**
3. 连接你的 GitHub 仓库 `HL42/Enterprise-Multi-Source-RAG-Agent`
4. Render 自动发现 `render.yaml`，解析出一个 Web Service（`rag-agent`）
5. 点击 **Apply** → Render 开始构建

构建过程（约 2-3 分钟）：
```
npm install      → 安装依赖（含 onnxruntime-node Linux 原生二进制）
npm run build    → Next.js 生产构建
docker deploy    → 启动 npm start
```

## 第三步：注入环境变量

部署完成后进入 **rag-agent** Web Service → **Environment** 页签，填入四个环境变量：

| 变量名 | 值 | 从哪里获取 |
|---|---|---|
| `DEEPSEEK_API_KEY` | `sk-...` | DeepSeek 控制台 |
| `NEXT_PUBLIC_SUPABASE_URL` | `https://xxxxxx.supabase.co` | Supabase → Project Settings → API → Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | `eyJ...`（JWT token） | Supabase → Project Settings → API → `service_role` key |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `eyJ...` 或 `sb_publishable_...` | Supabase → Project Settings → API → `anon public` key（可选，当前未使用） |

填完后点击 **Save Changes**，Render 自动重启服务。

## 第四步：验证

重启完成后，点击 Render 提供的 URL（如 `https://rag-agent.onrender.com`），看到聊天界面即部署成功。

输入"张伟的 IT 工单有哪些？"测试：
- 首次对话会先加载 embedding 模型（20-40 秒）
- 后续对话正常速度
- 如果返回错误，检查 Render Logs 页签查看具体报错

---

## 注意事项

### 免费套餐限制
- **512 MB RAM** — ONNX 模型 (~250MB) + Node.js (~150MB) ≈ 400MB，够用但紧
- **每月 750 小时** — 一个 Web Service 正好覆盖全天运行
- **15 分钟无请求自动休眠** — 休眠后首次请求需要 30-60 秒冷启动（重新加载模型）
- **休眠后模型会保留在磁盘**（除非部署新版本），不需要重新下载

### Embedding 模型生命周期
- 首次请求 → 模型下载到 Render 磁盘 → 加载到内存
- 后续请求 → 直接复用内存中的模型
- 重新部署（`git push`）→ 磁盘清空 → 需重新下载

### onnxruntime-node 兼容性
- Render 使用 Debian Linux x64，`onnxruntime-node@1.25.1` 有预编译二进制
- 如果构建失败，检查 `render.yaml` 的 `buildCommand` 是否需要 `npm install --build-from-source`

### 自定义域名
Render 免费套餐支持自定义域名：Dashboard → Web Service → Settings → Custom Domain
