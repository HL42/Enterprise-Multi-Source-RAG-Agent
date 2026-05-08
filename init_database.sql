-- ============================================================
-- 企业内部支持智能体 — 数据库初始化脚本
-- 适用环境: Supabase (PostgreSQL 15 + pgvector)
-- 执行方式: 在 Supabase Dashboard → SQL Editor 中粘贴并运行
-- ============================================================

-- ----------------------------------------
-- Step 0: 开启 pgvector 扩展
-- ----------------------------------------
CREATE EXTENSION IF NOT EXISTS vector;

-- ----------------------------------------
-- Step 1: 创建关系型表
-- ----------------------------------------

-- 1.1 员工表
CREATE TABLE IF NOT EXISTS employees (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(64)  NOT NULL,
  department  VARCHAR(64)  NOT NULL,
  position    VARCHAR(64)  NOT NULL,
  email       VARCHAR(128) NOT NULL UNIQUE,
  phone       VARCHAR(20),
  hire_date   DATE         NOT NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

COMMENT ON TABLE employees IS '员工信息表 — 关系型数据，供 Agent SQL Tool 查询';

-- 1.2 IT 工单表
CREATE TABLE IF NOT EXISTS it_tickets (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id  UUID         NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  title        VARCHAR(256) NOT NULL,
  description  TEXT,
  category     VARCHAR(32)  NOT NULL CHECK (category IN ('硬件', '软件', '网络', '账号', '安全', '其他')),
  status       VARCHAR(16)  NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
  priority     VARCHAR(8)   NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

COMMENT ON TABLE it_tickets IS 'IT 工单表 — 关系型数据，供 Agent SQL Tool 查询';

-- 工单查询常用索引
CREATE INDEX idx_tickets_status     ON it_tickets(status);
CREATE INDEX idx_tickets_employee   ON it_tickets(employee_id);
CREATE INDEX idx_tickets_created    ON it_tickets(created_at DESC);
CREATE INDEX idx_tickets_priority   ON it_tickets(priority);

-- ----------------------------------------
-- Step 2: 创建向量表（公司规章制度 RAG 知识库）
-- ----------------------------------------
CREATE TABLE IF NOT EXISTS company_policies (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title       VARCHAR(256) NOT NULL,
  content     TEXT         NOT NULL,
  category    VARCHAR(32)  NOT NULL,
  embedding   vector(384),              -- all-MiniLM-L6-v2 输出 384 维
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

COMMENT ON TABLE company_policies IS '公司规章制度向量表 — RAG 知识库，供 Agent Embedding Tool 检索';

-- 注意：向量索引暂未创建。数据量达到数百条后再执行：
-- CREATE INDEX idx_policies_embedding ON company_policies USING ivfflat (embedding vector_cosine_ops) WITH (lists = 1);

-- ----------------------------------------
-- Step 3: 插入中文测试数据
-- ----------------------------------------

-- 3.1 插入 5 名员工
INSERT INTO employees (name, department, position, email, phone, hire_date) VALUES
  ('张伟',   '技术部',   '高级后端工程师', 'zhangwei@company.cn',   '138-0001-0001', '2021-03-15'),
  ('李娜',   '人力资源部', 'HR 经理',       'lina@company.cn',      '138-0002-0002', '2019-07-01'),
  ('王磊',   '市场部',   '市场总监',       'wanglei@company.cn',    '138-0003-0003', '2020-01-10'),
  ('陈静',   '财务部',   '财务主管',       'chenjing@company.cn',   '138-0004-0004', '2018-11-20'),
  ('刘洋',   '技术部',   '前端开发工程师',  'liuyang@company.cn',    '138-0005-0005', '2022-06-01')
ON CONFLICT (email) DO NOTHING;

-- 3.2 插入 5 条 IT 工单
INSERT INTO it_tickets (employee_id, title, description, category, status, priority) VALUES
  (
    (SELECT id FROM employees WHERE email = 'zhangwei@company.cn'),
    '笔记本无法连接公司 Wi-Fi',
    '今天上午到办公室后，MacBook Pro 一直无法连接公司内网 Wi-Fi「Office-Net」，已尝试重启电脑和路由器，问题依旧。',
    '网络', 'open', 'high'
  ),
  (
    (SELECT id FROM employees WHERE email = 'lina@company.cn'),
    'HR 系统账号权限不足',
    '新入职员工信息录入时，HR 管理系统提示「权限不足」，无法完成批量导入操作，需要升级账号权限。',
    '账号', 'in_progress', 'high'
  ),
  (
    (SELECT id FROM employees WHERE email = 'wanglei@company.cn'),
    '会议室投影仪画面闪烁',
    'A301 会议室投影仪在使用过程中每隔几分钟会黑屏 2-3 秒，已经更换过 HDMI 线，问题未解决。',
    '硬件', 'open', 'medium'
  ),
  (
    (SELECT id FROM employees WHERE email = 'chenjing@company.cn'),
    '财务软件授权过期提醒',
    '金蝶财务软件提示授权将在 7 天后过期，需要 IT 协助续费或更新 License。',
    '软件', 'open', 'medium'
  ),
  (
    (SELECT id FROM employees WHERE email = 'liuyang@company.cn'),
    'VPN 远程连接频繁断开',
    '在家远程办公时，GlobalProtect VPN 每隔 15-20 分钟自动断开，严重影响代码提交和协作。',
    '网络', 'in_progress', 'urgent'
  );

-- 3.3 插入 5 条公司规章制度（RAG 知识库，embedding 字段后续由程序填充）
INSERT INTO company_policies (title, content, category) VALUES
  (
    '考勤管理制度',
    '公司实行弹性工作制，核心工作时间为上午 10:00 至下午 4:00。员工每日工作时间不少于 8 小时。'
    '迟到早退累计超过 3 次将记录为半天事假。'
    '远程办公需提前一天在 HR 系统中提交申请，经直属上级审批通过后方可执行。',
    '考勤'
  ),
  (
    'IT 设备使用规范',
    '公司配发的笔记本电脑和手机仅限工作用途，不得安装盗版软件或用于个人商业活动。'
    '设备丢失或被盗须在 2 小时内向 IT 部门报告，以便远程擦除数据。'
    '离职时须将所有设备交还 IT 部门，完成资产注销。',
    'IT管理'
  ),
  (
    '数据安全与保密协议',
    '严禁将公司源代码、客户数据、财务报表上传至外部云存储或个人邮箱。'
    '所有生产环境数据库的访问须通过堡垒机，并开启操作审计日志。'
    '发现数据泄露风险须在 1 小时内上报信息安全委员会。',
    '安全'
  ),
  (
    '差旅费用报销政策',
    '国内出差住宿标准：一线城市不超过 500 元/晚，其他城市不超过 350 元/晚。'
    '交通费用实报实销，高铁二等座及以下无需事前审批，一等座和商务座需部门总监审批。'
    '报销单须在差旅结束后 5 个工作日内提交，超期不予受理。',
    '财务'
  ),
  (
    '年假与调休制度',
    '员工入职满 1 年后享有 5 天带薪年假，工龄每增加 1 年增加 1 天，上限 15 天。'
    '法定节假日加班可申请调休，调休须在加班日起 3 个月内使用完毕，逾期自动作废。'
    '年假可跨年累积最多 5 天，超出部分于次年 3 月 31 日自动清零。',
    '考勤'
  );
