# AliMPay Bun

面向单用户、单实例部署的支付宝收款网关，也是供现有系统直接接入的易支付 API 兼容层。一个 Bun 进程同时提供 React 管理后台、公开收银台、易支付 V1/V2 兼容接口、支付宝 V3 账务明细查询和支付通知队列。

## 已实现

- Bun + Hono 后端、React 19 + Vite + Tailwind CSS 前端
- SQLite WAL 持久化，不依赖 MySQL、Redis 或 ORM
- 首次启动设置固定管理员 `admin`，密码使用 Argon2id
- 支付宝 V3 `alipay.data.bill.accountlog.query`，由官方 `alipay-sdk` 负责 RSA2 请求和响应验签
- 经营码精确金额匹配：为订单事务性分配 `+0.01` 至 `+0.99` 元
- 转账备注兼容模式：标准支付宝转账 URI，订单号写入 `memo`
- 易支付 V1 MD5：下单、页面支付、商户信息、单笔与批量订单查询、同步返回、异步通知
- 易支付 V2 RSA：下单、页面支付、订单查询、商户信息、订单列表、同步返回、异步通知
- 支付通知首次立即发送，失败后每 60 秒一次，自动任务最多 10 次
- 独立密钥中心：支付宝应用、V1、V2 平台、V2 商户四个信任方向不复用密钥
- 订单、支付流水、扫描运行、通知尝试和后台操作审计
- Docker/Compose、健康检查、桌面与移动端界面

不实现退款、代付、关单、结算和多商户。旧 PHP 版本的数据不会自动迁移。

## 工作方式

每个收银台有效 5 分钟，但订单会继续被有限监控至创建后第 10 分钟：

1. 没有待确认订单时，不请求支付宝。
2. 存在待确认订单时，全实例最多每 5 秒发起一轮合并账务查询，而不是每个订单单独查询。
3. 经营码按收入方向、唯一实付金额和发生时间匹配。
4. 转账模式额外要求 `trans_memo` 等于商户订单号。
5. 第 5–10 分钟到账记为 `late_paid`，对易支付接口仍映射为 `status=1` 并正常通知。
6. 第 10 分钟后停止自动匹配，过期订单与审计数据保留。

## 本地运行

要求 Bun 1.3 或更高版本。

```bash
bun install --frozen-lockfile
cp .env.example .env
bun run dev
```

- 前端开发地址：`http://localhost:5173`
- 后端地址：`http://localhost:3000`
- 生产构建：`bun run build && bun start`

首次启动会自动生成 32 字节随机主密钥，并以 `0600` 权限保存到 `DATA_DIR/.master-key`。`APP_MASTER_KEY` 不是支付宝应用私钥或易支付签名密钥，而是本程序用来加密数据库敏感字段的内部根密钥，通常无需手工设置。

只有在使用外部密钥管理系统时才需要显式设置 `APP_MASTER_KEY`，格式为 32 字节 Base64 或 64 位十六进制：

```bash
openssl rand -base64 32
```

一旦后台已经保存密钥，不要删除 `.master-key`，也不要在文件密钥和环境变量之间切换，否则已有加密数据将无法解密。

## 直接部署 Bun（推荐）

下面以 Linux、代码目录 `/opt/AliMPay`、监听 `127.0.0.1:3000` 为例。先安装 Bun 1.3 或更高版本，然后执行：

```bash
git clone https://github.com/MiaM1ku/AliMPay.git /opt/AliMPay
cd /opt/AliMPay
bun install --frozen-lockfile
cp .env.example .env
```

编辑 `.env`，至少把 `PUBLIC_BASE_URL` 改成实际 HTTPS 域名；`APP_MASTER_KEY` 保持空白即可自动生成。然后构建并试运行：

```bash
bun run build
bun run start
```

确认 `curl -fsS http://127.0.0.1:3000/healthz` 返回正常后，可配置 systemd。先用 `command -v bun` 确认 Bun 的绝对路径，并按实际运行账户修改下面的 `User` 和 `ExecStart`：

```ini
# /etc/systemd/system/alimpay.service
[Unit]
Description=AliMPay Bun gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=YOUR_USER
WorkingDirectory=/opt/AliMPay
EnvironmentFile=/opt/AliMPay/.env
ExecStart=/home/YOUR_USER/.bun/bin/bun run start
Restart=on-failure
RestartSec=3
UMask=0077

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now alimpay
sudo systemctl status alimpay
sudo journalctl -u alimpay -n 100 --no-pager
```

只运行一个应用进程。当前实现的扫描合并与通知认领以单进程为边界，不支持多副本横向扩容。

## Docker Compose（可选）

创建 `.env`：

```dotenv
PUBLIC_BASE_URL=https://pay.example.com
# APP_MASTER_KEY 可留空，由程序首次启动自动生成
```

启动：

```bash
docker compose up -d --build
docker compose ps
curl -fsS http://127.0.0.1:3000/healthz
```

Compose 默认只把端口绑定到 `127.0.0.1:3000`，应由 Caddy、Nginx 或其他 HTTPS 反向代理对外提供服务。Nginx 最小配置示例：

```nginx
server {
    listen 443 ssl http2;
    server_name pay.example.com;

    client_max_body_size 6m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 30s;
    }
}
```

无论直接运行还是使用 Compose，都应把 `data` 目录放在持久磁盘并纳入备份。

## 首次配置顺序

1. 访问公开域名，设置 `admin` 的管理员密码和公开根地址。
2. 在“密钥中心”生成支付宝应用 RSA 密钥。
3. 在密钥中心复制已经去掉 PEM 头尾和换行的“应用公钥（支付宝上传格式）”，填写到支付宝开放平台，妥善备份应用私钥。
4. 在“收款配置”填写支付宝应用 ID 和“支付宝公钥”。注意它不是应用公钥。
5. 确认应用具备账务明细查询权限，并在后台执行连接测试。
6. 上传支付宝经营码；如必须使用转账模式，填写收款方支付宝用户 ID。
7. V1 直接复制 PID/key；V2 生成商户密钥对，商户私钥只展示一次，平台只保存商户公钥。

支付宝参考：

- [应用私钥生成说明](https://opendocs.alipay.com/common/055l5k)
- [密钥相关说明](https://opendocs.alipay.com/common/02kf5p.md)
- [V3 账务明细查询](https://opendocs.alipay.com/open-v3/26ed84be_alipay.data.bill.accountlog.query)

## 易支付接口

只接受 `type=alipay`。

### V1 MD5

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET/POST | `/submit.php` | 页面跳转支付 |
| POST | `/mapi.php` | API 下单 |
| GET/POST | `/api.php?act=query` | 商户信息 |
| GET/POST | `/api.php?act=order` | 单笔订单查询 |
| GET/POST | `/api.php?act=orders` | 订单列表 |

签名时排除空值、数组、`sign`、`sign_type`，按参数名 ASCII 升序连接为 `key=value&key=value`，直接追加 V1 key 后计算小写 MD5。

V1 查询接口必须同时提供 PID 和 key；不存在旧版本那种无需密钥的前端查询入口。

### V2 RSA

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET/POST | `/api/pay/submit` | 页面跳转支付 |
| POST | `/api/pay/create` | 统一下单 |
| POST | `/api/pay/query` | 订单查询 |
| POST | `/api/merchant/info` | 商户信息 |
| POST | `/api/merchant/orders` | 订单列表 |

V2 使用 SHA256WithRSA（PKCS#1 v1.5），请求由商户私钥签名，响应与支付通知由平台私钥签名。`timestamp` 是 10 位秒级时间戳，允许与服务器时间相差 300 秒。

密钥中心以不带 PEM 头尾和换行的单行 Base64 显示 V2 平台公钥与商户公钥。导入商户公钥时同时兼容这种 `MIIB...` 格式和完整 PEM 格式。

具体实例地址、PID 和签名说明可在后台“API 文档”查看。

## 通知语义

- `notify_url` 与 `return_url` 只接受 HTTP/HTTPS，禁止 URL 内嵌用户名或密码。
- 默认拒绝本机、私网、链路本地和保留地址；通知前会重新解析 DNS，并禁止跳转。
- 仅当响应为 2xx 且正文去除首尾空白后严格等于 `success` 才确认成功。
- 自动通知最多 10 次：第 1 次立即发送，之后固定每 60 秒一次。
- 后台“补发通知”创建一个独立的一次性任务，不会重置原任务的尝试次数。
- 如确实要向私网测试服务器回调，可设置 `ALLOW_PRIVATE_CALLBACKS=true`；不要在普通生产部署启用。

## 安全与数据

- 管理会话使用 Secure（生产）、HttpOnly、SameSite=Strict Cookie。
- 后台写操作同时校验 CSRF token 和请求 Origin。
- 应用私钥、V1 key、V2 平台私钥使用 `APP_MASTER_KEY` 经 AES-256-GCM 加密后写入数据库。
- V2 商户私钥不落库；生成时只返回一次。
- 金额始终以整数分存储，不使用浮点数做匹配。
- `(pid, out_trade_no)`、支付宝 `account_log_id` 和活动金额预留均有数据库唯一约束。
- 回调响应、日志和审计不会记录明文密钥。

`TRUST_PROXY=true` 只应在应用前方确有可信反向代理时开启，否则不要信任客户端提交的转发 IP 头。

## 备份与恢复

持久数据都在 `DATA_DIR`（Docker 中为 `/data`）：

- `alimpay.sqlite`、`alimpay.sqlite-wal`、`alimpay.sqlite-shm`
- `uploads/` 经营码图片
- 自动生成的 `.master-key`（如显式设置 `APP_MASTER_KEY`，则另行备份环境变量）

在线备份优先使用 SQLite backup：

```bash
sqlite3 data/alimpay.sqlite ".backup 'alimpay-$(date +%F).sqlite'"
```

恢复时先停止 Bun 进程，再恢复数据库、上传目录和与之匹配的 `.master-key`；如使用环境变量，则恢复相同的 `APP_MASTER_KEY`。主密钥不匹配时，所有加密私钥都无法解密。

## 测试

```bash
bun run typecheck
bun run test
bun run build
bunx playwright install chromium
bun run test:e2e
```

单元与契约测试覆盖 V1/V2 签名、订单幂等、金额分配、5/10 分钟状态机、账务流水去重、共享扫描、通知十次重试、会话与 CSRF、SSRF，以及桌面首次配置和移动端页面。

## 健康检查

- `GET /healthz`：进程存活
- `GET /readyz`：数据库可用，并额外返回 `gateway_ready` 表示收款配置是否完整

时间统一以 UTC 存库；支付宝请求按 Asia/Shanghai 格式化；后台按 Asia/Taipei 展示。
