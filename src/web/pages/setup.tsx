import { ArrowRight, CheckCircle2, KeyRound, ScanLine, ShieldCheck, WalletCards } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import useSWR, { mutate } from "swr";
import { apiFetch, jsonBody, swrFetcher } from "@/web/api";
import { Button } from "@/web/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/web/components/ui/card";
import { Input } from "@/web/components/ui/input";
import { Label } from "@/web/components/ui/label";
import { Loading } from "@/web/components/ui/loading";

export function SetupPage() {
  const navigate = useNavigate();
  const { data, isLoading } = useSWR<{ setup_completed: boolean }>("/admin-api/setup/status", swrFetcher);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [baseUrl, setBaseUrl] = useState(window.location.origin);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  if (isLoading) return <Loading label="正在检查系统状态" />;
  if (data?.setup_completed) return <Navigate to="/login" replace />;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (password !== confirmation) {
      setError("两次输入的密码不一致");
      return;
    }
    setSubmitting(true);
    try {
      await apiFetch("/admin-api/setup", { method: "POST", ...jsonBody({ password, public_base_url: baseUrl }) });
      await mutate("/admin-api/setup/status");
      await mutate("/admin-api/me");
      navigate("/dashboard", { replace: true });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "初始化失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="min-h-screen px-4 py-10 sm:py-16">
      <div className="mx-auto grid max-w-5xl gap-10 lg:grid-cols-[1fr_440px] lg:items-center">
        <section className="max-w-xl">
          <div className="mb-8 flex items-center gap-3">
            <span className="flex size-10 items-center justify-center rounded-md bg-primary text-background"><WalletCards className="size-5" /></span>
            <div><div className="font-semibold">AliMPay</div><div className="text-sm text-muted">Bun 单商户收款网关</div></div>
          </div>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">先完成三项基础配置</h1>
          <p className="mt-4 text-base leading-7 text-muted">初始化会创建固定管理员 admin、V1 MD5 凭据和 V2 平台密钥。支付宝应用密钥与经营码稍后在后台配置。</p>
          <div className="mt-8 space-y-5">
            {[
              { icon: ShieldCheck, title: "本机加密存储", text: "敏感密钥使用 AES-256-GCM 加密后写入 SQLite。" },
              { icon: KeyRound, title: "协议密钥隔离", text: "支付宝、易支付 V1 与 V2 使用三套独立凭据。" },
              { icon: ScanLine, title: "有限频率扫单", text: "只有待确认订单存在时，才会每 5 秒合并查询一次账单。" },
            ].map((item) => (
              <div key={item.title} className="flex gap-3">
                <item.icon className="mt-0.5 size-5 shrink-0 text-primary" />
                <div><h2 className="text-sm font-semibold">{item.title}</h2><p className="mt-1 text-sm leading-5 text-muted">{item.text}</p></div>
              </div>
            ))}
          </div>
        </section>

        <Card>
          <CardHeader>
            <CardTitle>首次配置</CardTitle>
            <CardDescription>公开地址应填写反向代理后的 HTTPS 根地址。</CardDescription>
          </CardHeader>
          <CardContent>
            <form className="space-y-5" onSubmit={submit}>
              <div className="space-y-2">
                <Label htmlFor="username">管理员用户名</Label>
                <Input id="username" value="admin" disabled />
              </div>
              <div className="space-y-2">
                <Label htmlFor="base-url">公开访问地址</Label>
                <Input id="base-url" type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} required />
                <p className="text-xs leading-5 text-muted">用于生成收银台、经营码图片和商户 API 返回地址。</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">管理员密码</Label>
                <Input id="password" type="password" minLength={12} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="confirmation">确认密码</Label>
                <Input id="confirmation" type="password" minLength={12} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="new-password" required />
              </div>
              {error ? <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive" role="alert">{error}</div> : null}
              <Button className="w-full" size="lg" disabled={submitting}>
                {submitting ? "正在初始化…" : "创建并进入后台"}<ArrowRight />
              </Button>
              <div className="flex items-start gap-2 text-xs leading-5 text-muted"><CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" />主密钥已在首次启动时自动生成；备份 data 目录时请一并保存 .master-key。</div>
            </form>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
