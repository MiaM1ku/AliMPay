import { CheckCircle2, Database, HardDrive, LockKeyhole, Server, XCircle } from "lucide-react";
import { type FormEvent, useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import { apiFetch, jsonBody, swrFetcher } from "@/web/api";
import { PageHeader } from "@/web/components/page-header";
import { Badge } from "@/web/components/ui/badge";
import { Button } from "@/web/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/web/components/ui/card";
import { Input } from "@/web/components/ui/input";
import { Label } from "@/web/components/ui/label";
import { Loading } from "@/web/components/ui/loading";
import { formatDate } from "@/web/lib/utils";

interface SystemData {
  ready: boolean;
  bun_version: string;
  database_path: string;
  data_dir: string;
  alipay_configured: boolean;
  active_mode_ready: boolean;
  callbacks_private_allowed: boolean;
}

interface ScanResponse { data: Array<Record<string, unknown>> }

function HealthRow({ label, ready, detail }: { label: string; ready: boolean; detail: string }) {
  return <div className="flex items-start justify-between gap-4 border-t py-3"><div><div className="text-sm font-medium">{label}</div><p className="mt-1 text-xs text-muted">{detail}</p></div>{ready ? <CheckCircle2 className="size-5 shrink-0 text-success" /> : <XCircle className="size-5 shrink-0 text-destructive" />}</div>;
}

export function SystemPage() {
  const { data, isLoading } = useSWR<SystemData>("/admin-api/system", swrFetcher, { refreshInterval: 10_000 });
  const { data: scans } = useSWR<ScanResponse>("/admin-api/scans?limit=15", swrFetcher, { refreshInterval: 5_000 });
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  if (isLoading || !data) return <Loading label="正在检查系统" />;

  async function changePassword(event: FormEvent) {
    event.preventDefault();
    try {
      await apiFetch("/admin-api/password", { method: "PUT", ...jsonBody({ current_password: currentPassword, new_password: newPassword }) });
      setCurrentPassword(""); setNewPassword(""); toast.success("管理员密码已更新");
    } catch (error) { toast.error(error instanceof Error ? error.message : "修改失败"); }
  }

  return (
    <>
      <PageHeader title="系统状态" description="运行环境、扫描记录、数据目录与管理员安全设置。" />
      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>就绪检查</CardTitle><CardDescription>健康接口：/healthz；就绪接口：/readyz。</CardDescription></CardHeader>
          <CardContent>
            <HealthRow label="Bun 服务与 SQLite" ready={data.ready} detail={`Bun ${data.bun_version}`} />
            <HealthRow label="支付宝 V3 凭据" ready={data.alipay_configured} detail="应用 ID、应用私钥和支付宝公钥" />
            <HealthRow label="当前收款模式" ready={data.active_mode_ready} detail="经营码图片或转账用户 ID" />
            <div className="mt-4 grid gap-3 sm:grid-cols-2"><div className="rounded-md border p-3"><Server className="size-4 text-primary" /><div className="mt-2 text-xs text-muted">数据目录</div><code className="mt-1 block break-all text-xs">{data.data_dir}</code></div><div className="rounded-md border p-3"><Database className="size-4 text-primary" /><div className="mt-2 text-xs text-muted">数据库</div><code className="mt-1 block break-all text-xs">{data.database_path}</code></div></div>
            {data.callbacks_private_allowed ? <div className="mt-4 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">ALLOW_PRIVATE_CALLBACKS 已启用，通知可以访问私有网络。只应在受控环境使用。</div> : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>数据备份</CardTitle><CardDescription>一个实例只应由一个 Bun 进程写入。</CardDescription></CardHeader>
          <CardContent className="space-y-4 text-sm leading-6 text-muted">
            <div className="flex gap-3"><HardDrive className="mt-0.5 size-5 shrink-0 text-primary" /><p>备份整个 data 目录，至少包含 SQLite 主库、WAL/SHM、上传经营码和自动生成的 .master-key。在线备份优先使用 SQLite backup 命令。</p></div>
            <div className="flex gap-3"><LockKeyhole className="mt-0.5 size-5 shrink-0 text-primary" /><p>如通过环境变量显式设置 APP_MASTER_KEY，请另行备份该值。无论采用哪种方式，遗失或更换主密钥后，加密私钥都无法恢复。</p></div>
            <pre className="overflow-x-auto rounded-md border bg-foreground/[0.025] p-3 font-mono text-xs text-foreground">sqlite3 data/alimpay.sqlite ".backup 'backup.sqlite'"</pre>
          </CardContent>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader><CardTitle>最近扫描</CardTitle><CardDescription>没有有效监控订单时，上游请求为零并记录 skipped。</CardDescription></CardHeader>
        <CardContent>
          {!scans?.data.length ? <div className="py-10 text-center text-sm text-muted">暂无扫描记录</div> : <div className="overflow-x-auto"><table className="w-full min-w-[720px] text-left text-sm"><thead className="border-b text-xs text-muted"><tr><th className="pb-3 font-medium">开始时间</th><th className="pb-3 font-medium">状态</th><th className="pb-3 font-medium">活动订单</th><th className="pb-3 font-medium">页 / 记录 / 匹配</th><th className="pb-3 font-medium">Trace ID</th></tr></thead><tbody className="divide-y">{scans.data.map((scan) => <tr key={String(scan.id)}><td className="py-3 text-xs">{formatDate(String(scan.started_at))}</td><td className="py-3"><Badge variant={scan.status === "success" ? "success" : scan.status === "error" ? "danger" : "outline"}>{String(scan.status)}</Badge></td><td className="py-3">{String(scan.active_orders)}</td><td className="py-3 font-mono text-xs">{String(scan.pages)} / {String(scan.records)} / {String(scan.matched)}</td><td className="max-w-52 truncate py-3 font-mono text-xs text-muted">{String(scan.trace_id ?? "—")}</td></tr>)}</tbody></table></div>}
        </CardContent>
      </Card>

      <Card className="mt-6 max-w-2xl">
        <CardHeader><CardTitle>修改管理员密码</CardTitle><CardDescription>新密码至少 12 位；修改后当前会话保持有效。</CardDescription></CardHeader>
        <CardContent><form className="space-y-4" onSubmit={changePassword}><div className="space-y-2"><Label htmlFor="current-password">当前密码</Label><Input id="current-password" type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required /></div><div className="space-y-2"><Label htmlFor="new-password">新密码</Label><Input id="new-password" type="password" minLength={12} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required /></div><Button>更新密码</Button></form></CardContent>
      </Card>
    </>
  );
}
