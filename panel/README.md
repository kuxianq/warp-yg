# WARP Panel · V0.2

这是在 `warp-yg` fork 基础上新增的一层 Web 管理面板。目标不是替代原仓库的 WARP / Socks5 底层能力，而是**在保留原能力的前提下，额外提供一个更直观的控制台**，方便通过网页完成状态查看、代理开关、端口调整、日志排查和基础运维操作。

---

## 当前功能

### 1. 登录与首页
- 独立登录页（密码登录后进入面板）
- 首页总览卡片：
  - WARP 状态
  - 本机代理端口
  - 对外代理端口
  - 代理出口 IP

### 2. 常用操作
- 打开代理
- 关闭代理
- 切换工作方式
- 保存工作方式

### 3. 端口和连接信息
- 设置本机代理端口
- 设置对外代理端口
- 启用 / 更新 / 重启 / 停用对外代理
- 区分“本机使用端口”和“外部设备接入端口”

### 4. 账户与授权
- 写入 WARP+ License
- 重新注册 WARP 账户

### 5. 准备 / 修复代理环境
- 一键准备 Socks5-WARP 环境
- 自动补齐：
  - `cloudflare-warp`
  - WARP 注册
  - 代理模式
  - 端口设置
  - 公网转发（按配置启用）

### 6. 日志与诊断
- 查看 `warp-svc` 日志
- 查看 `warp-socks5-public.service` 日志
- 查看监听端口 / trace / 设置详情

### 7. 重置 / 清理
- 支持带确认短语的清理动作
- 可选同时卸载 `cloudflare-warp`

---

## 启动 / 部署方式

### 本地运行
```bash
cd panel
npm install
PORT=43123 PANEL_PASSWORD='your-password' npm start
```

然后访问：
```text
http://<server-ip>:43123
```

### systemd 部署
仓库里附带示例文件：

```text
panel/warp-panel.service.example
```

当前推荐部署参数：
- 服务名：`warp-panel.service`
- 默认端口：`43123`
- 部署目录示例：`/opt/warp-yg/panel`

### 脚本雏形
当前已附带部署脚本雏形：

```text
panel/scripts/deploy.sh
```

支持命令：
```bash
bash panel/scripts/deploy.sh deploy [source_dir]
bash panel/scripts/deploy.sh update [source_dir]
bash panel/scripts/deploy.sh rollback <backup>
bash panel/scripts/deploy.sh list
```

---

## 实现说明

### 前端
- 原生 HTML / CSS / JavaScript
- 零构建依赖，直接由 Express 静态托管
- 当前以“小白先能用”为优先，首屏聚焦常用操作，其他功能逐步收进折叠区域

### 后端
- Node.js + Express
- 主要通过本机命令控制和读取状态：
  - `warp-cli`
  - `systemctl`
  - `journalctl`
  - `ss`
  - `curl`

### 当前后端能力
- 全局操作锁（避免并发操作打架）
- 幂等处理（重复执行尽量返回 noop 而不是报错）
- 标准状态对象输出
- 审计日志记录（本地 JSONL）
- 统一日志接口

### 当前约束
- 当前主要完整支持 **Socks5-WARP** 路线
- `warp-go` / `wgcf` 仍保留为后续扩展方向，不在本版本强行接入

---

## 安全说明

- 面板默认采用密码登录
- **不要把面板直接裸露到公网且使用弱密码**
- 如果面板需要公网访问，建议至少配一层：
  - Nginx Basic Auth
  - Cloudflare Access
  - 或 IP 白名单
- 公网 Socks5 代理端口本身建议继续通过防火墙 / 安全组限制来源
- 当前版本涉及系统配置、服务启停、软件安装，因此运行账户需要具备对应权限

---

## 后续可扩展

- 更完整的小白首页 / 引导流程
- 连接信息卡一键复制优化
- 更细的健康检查字段
- 审计日志轮转与可视化
- 更强的登录会话控制
- `warp-go` / `wgcf` 接入
- 更完整的部署/更新/回滚自动化
- 面板内更细的故障自检与修复建议

---

## 当前版本定位

**V0.2** 的定位是：
> 已具备可用的 Web 控制台雏形，能完成 WARP / Socks5 的日常查看、开关、端口调整、日志排查和基础环境修复，但仍处于持续打磨阶段。
