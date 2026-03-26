# WARP Panel (V1)

这是在 `warp-yg` fork 基础上新增的一层 Web 面板，目标是把原本以脚本/命令行为主的 WARP 管理流程，收口成一个可视化控制台。

## 当前功能（V1）

- 查看 WARP 当前连接状态
- 查看当前模式、内部 SOCKS5 端口、公网转发端口
- 查看直连 IP / 代理出口 IP / Cloudflare trace
- 切换模式（`proxy` / `warp` / `warp+doh` / `warp+dot` / `tunnel_only` 等）
- 修改内部代理端口
- 启用 / 更新 / 重启 / 停用公网转发服务
- 写入 WARP+ license
- 重新注册 WARP 账户
- 查看 `warp-svc` 与 `warp-socks5-public.service` 日志

## 启动方式

```bash
cd panel
npm install
PORT=43123 PANEL_PASSWORD='your-password' npm start
```

然后访问：

```text
http://<server-ip>:43123
```

## systemd 示例

仓库里附带了一个示例文件：

```text
panel/warp-panel.service.example
```

你后续部署时可以按这个模板改成正式服务。

## 安全说明

- **强烈建议设置 `PANEL_PASSWORD`**，不要裸开到公网。
- 如果面板公网开放，建议再配一层 Nginx / Cloudflare Access / 防火墙白名单。
- 公网 SOCKS5 转发本身仍应通过 UFW / 安全组做白名单控制。

## 当前实现说明

- 后端：Node.js + Express
- 前端：原生 HTML/CSS/JS（零构建）
- 控制方式：调用 `warp-cli`、`systemctl`、`journalctl`、`ss` 等本机命令

## 后续可扩展

- 登录会话持久化
- 面板多用户 / RBAC
- 更细的网络诊断页
- 配置变更审计日志
- 面板部署脚本 / systemd 服务模板
- 适配 `warp-go` / `wgcf` 更细粒度的模式控制
