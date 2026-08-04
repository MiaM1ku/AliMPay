import { LogIn, WalletCards } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import useSWR, { mutate } from "swr";
import { apiFetch, jsonBody, swrFetcher } from "@/web/api";
import { Button } from "@/web/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/web/components/ui/card";
import { Input } from "@/web/components/ui/input";
import { Label } from "@/web/components/ui/label";
import { Loading } from "@/web/components/ui/loading";

export function LoginPage() {
  const navigate = useNavigate();
  const { data, isLoading } = useSWR<{ setup_completed: boolean }>("/admin-api/setup/status", swrFetcher);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  if (isLoading) return <Loading />;
  if (!data?.setup_completed) return <Navigate to="/setup" replace />;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      await apiFetch("/admin-api/login", { method: "POST", ...jsonBody({ username: "admin", password }) });
      await mutate("/admin-api/me");
      navigate("/dashboard", { replace: true });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "登录失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-3">
          <span className="flex size-9 items-center justify-center rounded-md bg-primary text-background"><WalletCards className="size-4" /></span>
          <div><div className="font-semibold">AliMPay</div><div className="text-xs text-muted">支付运维控制台</div></div>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>管理员登录</CardTitle>
            <CardDescription>单用户部署，用户名固定为 admin。</CardDescription>
          </CardHeader>
          <CardContent>
            <form className="space-y-4" onSubmit={submit}>
              <div className="space-y-2"><Label htmlFor="login-user">用户名</Label><Input id="login-user" value="admin" disabled /></div>
              <div className="space-y-2"><Label htmlFor="login-password">密码</Label><Input id="login-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoFocus autoComplete="current-password" required /></div>
              {error ? <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive" role="alert">{error}</div> : null}
              <Button className="w-full" disabled={submitting}>{submitting ? "正在验证…" : "登录"}<LogIn /></Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
