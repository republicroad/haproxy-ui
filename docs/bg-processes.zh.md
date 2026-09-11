# 最佳实践：从自动化中启动长时运行进程

从 shell 工具、CI 步骤或代理会话中启动一个长时运行进程（开发服务器、模拟 API、webhook 接收器）可能会让调用方会话永久挂起。本文档记录了这一问题的根本原因以及本项目的标准规避方式。

## 根本原因

当子进程继承了父进程的 stdout/stderr **管道句柄**时，调用方 shell 会一直等待这些管道关闭（出现 EOF）。长时运行进程永远不会关闭它们，因此任何等待命令结束——并等待所有输出流到达 EOF——的工具都会一直挂起直到超时。进程本身通常运行正常；只是会话卡住了。

本项目中发现两种加剧问题的模式：

- `spawn` / `Start-Process` **未**使用 detached + `stdio: "ignore"`（管道被继承）
- 在**同一个** shell 命令中启动进程**并**探测就绪状态（窗口期很长，任何慢步骤都会触发超时）

## 规则

> 从自动化启动的子进程不得持有任何继承的管道。
> 将其分离（detach）、忽略其 stdio、记录其 PID，并在**单独的**步骤中验证就绪状态。

## 标准模式（本项目）

使用 `scripts/start-bg.mjs`，它封装了 `spawn(cmd, args, { detached: true, stdio: "ignore" })`：

```bash
# 启动（立即返回）
node scripts/start-bg.mjs --pidfile "$TEMP/mock.pid" --name mock -- \
  node scripts/mock-dataplaneapi.mjs

# 然后，在 SEPARATE（单独的）命令中，带截止时限地等待就绪
# （端口探测循环），绝不在同一次调用中盲目 sleep。
```

属性说明：

- `stdio: "ignore"` → 不存在管道，无需等待任何东西，启动器立即退出
- `detached: true`（+ `windowsHide`）→ 子进程在启动器会话结束后继续存活；在 POSIX 上它拥有自己的进程组
- PID 文件 → 让后续步骤能停止进程，并防止意外双重启动（当记录到的 PID 仍存活时，`start-bg` 会拒绝启动）
- 就绪检查属于**另一个**调用：用截止时限轮询端口或 HTTP 端点

### 停止进程

```bash
# Windows
taskkill /PID $(cat "$TEMP/mock.pid") /F /T
# POSIX
kill "$(cat "$TEMP/mock.pid")"
```

`tests/global-teardown.mjs` 正是为 Playwright 测试套件实现了这一逻辑。

## 备选方案对比（以及适用时机）

| 方案 | 结论 |
| --- | --- |
| `docker compose up -d` | 依赖服务（我们的 hap1/hap2）的最佳选择。内置分离（detached）语义。 |
| 进程管理器（pm2、NSSM/WinSW、systemd） | 长命的正式服务的正确选择；对临时的开发/测试进程来说杀鸡用牛刀。 |
| Playwright `webServer` 配置 | E2E 测试套件的最佳选择；运行器负责生命周期。 |
| MSYS2/Git-Bash `& disown` | 可缓解（bash 不等待后台任务），但除非重定向（`>log 2>&1 </dev/null`），子进程仍会继承句柄；为此切换整个工具链的 shell 不值当。 |
| `Start-Job`（PowerShell） | 避免：job 会随父会话一起消亡。 |
| pwsh 中的裸 `&` / 带 `-RedirectStandardOutput` 的 `Start-Process` | 避免：管道被继承；调用会话会一直等待。 |

## 总结检查清单

1. 分离子进程（`detached: true`、`stdio: "ignore"`、`windowsHide`）。
2. 写入 PID 文件；拒绝双重启动。
3. 在单独的步骤中，通过有界的探测循环验证就绪状态。
4. 通过 PID 文件停止进程（绝不用 `taskkill /IM node.exe`——那会杀掉无关进程）。