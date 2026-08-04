import { CheckCircle2, QrCode, Save, Send, Upload } from "lucide-react";
import { type FormEvent, useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import type { CollectionMode, PublicSettings, TransferLinkLayer } from "@/shared/contracts";
import { apiFetch, jsonBody, swrFetcher } from "@/web/api";
import { PageHeader } from "@/web/components/page-header";
import { Badge } from "@/web/components/ui/badge";
import { Button } from "@/web/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/web/components/ui/card";
import { Input } from "@/web/components/ui/input";
import { Label } from "@/web/components/ui/label";
import { Loading } from "@/web/components/ui/loading";
import { Switch } from "@/web/components/ui/switch";
import { Textarea } from "@/web/components/ui/textarea";
import { cn } from "@/web/lib/utils";

interface SettingsData extends PublicSettings {
  transfer_user_id: string;
  alipay_public_key: string;
  has_alipay_private_key: boolean;
  has_v1_key: boolean;
  has_v2_platform_private_key: boolean;
}

function SettingsForm({ initial, refresh }: { initial: SettingsData; refresh: () => Promise<unknown> }) {
  const [mode, setMode] = useState<CollectionMode>(initial.collection_mode);
  const [baseUrl, setBaseUrl] = useState(initial.public_base_url);
  const [transferUserId, setTransferUserId] = useState(initial.transfer_user_id);
  const [transferLinkLayer, setTransferLinkLayer] = useState<TransferLinkLayer>(initial.transfer_link_layer);
  const [appId, setAppId] = useState(initial.alipay_app_id);
  const [endpoint, setEndpoint] = useState(initial.alipay_endpoint);
  const [alipayPublicKey, setAlipayPublicKey] = useState(initial.alipay_public_key);
  const [v1Enabled, setV1Enabled] = useState(initial.v1_enabled);
  const [v2Enabled, setV2Enabled] = useState(initial.v2_enabled);
  const [saving, setSaving] = useState(false);

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await apiFetch("/admin-api/settings", {
        method: "PUT",
        ...jsonBody({
          public_base_url: baseUrl,
          collection_mode: mode,
          transfer_user_id: transferUserId,
          transfer_link_layer: transferLinkLayer,
          alipay_app_id: appId,
          alipay_endpoint: endpoint,
          alipay_public_key: alipayPublicKey,
          v1_enabled: v1Enabled,
          v2_enabled: v2Enabled,
        }),
      });
      toast.success("配置已保存");
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-6">
      <Card>
        <CardHeader><CardTitle>收款方式</CardTitle><CardDescription>经营码金额匹配更稳定；同一时刻的订单会分配不同分位金额。</CardDescription></CardHeader>
        <CardContent>
          <div className="grid gap-3 md:grid-cols-2">
            <button type="button" onClick={() => setMode("business_qr")} className={cn("rounded-lg border p-4 text-left transition-colors", mode === "business_qr" ? "border-primary bg-primary/5" : "hover:bg-foreground/[0.025]")}>
              <div className="flex items-center justify-between"><span className="flex items-center gap-2 font-semibold"><QrCode className="size-4 text-primary" />经营码</span><Badge variant={mode === "business_qr" ? "primary" : "outline"}>{mode === "business_qr" ? "当前使用" : "推荐"}</Badge></div>
              <p className="mt-2 text-sm leading-5 text-muted">上传支付宝经营码，订单实付金额在原价上增加 0.01–0.99 元并精确匹配。</p>
            </button>
            <button type="button" onClick={() => setMode("transfer")} className={cn("rounded-lg border p-4 text-left transition-colors", mode === "transfer" ? "border-primary bg-primary/5" : "hover:bg-foreground/[0.025]")}>
              <div className="flex items-center justify-between"><span className="flex items-center gap-2 font-semibold"><Send className="size-4 text-primary" />转账备注</span><Badge variant={mode === "transfer" ? "primary" : "outline"}>{mode === "transfer" ? "当前使用" : "兼容模式"}</Badge></div>
              <p className="mt-2 text-sm leading-5 text-muted">生成支付宝转账 URI，使用商户订单号作为 memo，同时校验金额与时间。</p>
            </button>
          </div>

          <div className="mt-5 grid gap-5 md:grid-cols-2">
            <div className="space-y-3">
              <Label htmlFor="qr-file">经营码图片</Label>
              {initial.business_qr_url ? <div className="flex items-center gap-3 rounded-md border p-3"><img src={initial.business_qr_url} alt="已上传的支付宝经营码" className="size-20 object-contain" /><div className="min-w-0"><div className="flex items-center gap-2 text-sm font-medium"><CheckCircle2 className="size-4 text-success" />已上传</div><p className="mt-1 truncate text-xs text-muted">{initial.business_qr_url}</p></div></div> : <div className="rounded-md border border-dashed p-5 text-center text-sm text-muted">尚未上传经营码</div>}
              <Input id="qr-file" type="file" accept="image/png,image/jpeg,image/webp" onChange={async (event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                const form = new FormData();
                form.set("file", file);
                try {
                  await apiFetch("/admin-api/settings/qr", { method: "POST", body: form });
                  toast.success("经营码已上传");
                  await refresh();
                } catch (error) { toast.error(error instanceof Error ? error.message : "上传失败"); }
              }} />
              <p className="flex items-start gap-2 text-xs leading-5 text-muted"><Upload className="mt-0.5 size-3.5 shrink-0" />支持 PNG、JPEG、WebP，最大 5MB。</p>
            </div>
            <div className="space-y-3">
              <Label htmlFor="transfer-user">支付宝用户 ID</Label>
              <Input id="transfer-user" inputMode="numeric" value={transferUserId} onChange={(event) => setTransferUserId(event.target.value.trim())} placeholder="2088…" />
              <Label htmlFor="transfer-link-layer">转账链接包裹层级</Label>
              <select
                id="transfer-link-layer"
                value={transferLinkLayer}
                onChange={(event) => setTransferLinkLayer(Number(event.target.value) as TransferLinkLayer)}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <option value={1}>第 1 层 · 完整五层 HTTPS</option>
                <option value={2}>第 2 层 · 双重包裹 HTTPS</option>
                <option value={3}>第 3 层 · 外层 alipays Scheme</option>
                <option value={4}>第 4 层 · 单层支付宝 HTTPS（已验证可用）</option>
                <option value={5}>第 5 层 · 原始 alipays Scheme</option>
              </select>
              <p className="text-xs leading-5 text-muted">配置会同时作用于收银台二维码、V1 qrcode 和 V2 pay_info；更换后新生成或重新打开的支付页面立即生效。</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>支付宝 V3 账单接口</CardTitle><CardDescription>使用官方 Node SDK 发起 GET /v3/alipay/data/bill/accountlog/query，并校验响应签名。</CardDescription></CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-5 md:grid-cols-2">
            <div className="space-y-2"><Label htmlFor="app-id">应用 ID</Label><Input id="app-id" value={appId} onChange={(event) => setAppId(event.target.value.trim())} placeholder="支付宝开放平台 AppId" /></div>
            <div className="space-y-2"><Label htmlFor="endpoint">V3 Endpoint</Label><Input id="endpoint" type="url" value={endpoint} onChange={(event) => setEndpoint(event.target.value)} /></div>
          </div>
          <div className="space-y-2"><Label htmlFor="alipay-public">支付宝公钥</Label><Textarea id="alipay-public" rows={7} value={alipayPublicKey} onChange={(event) => setAlipayPublicKey(event.target.value)} placeholder="-----BEGIN PUBLIC KEY-----" /><p className="text-xs text-muted">这里填写支付宝公钥，不是应用公钥。应用私钥在密钥中心生成或导入。</p></div>
          <div className="flex flex-wrap items-center gap-3">
            <Badge variant={initial.alipay_configured ? "success" : "danger"}>{initial.alipay_configured ? "凭据完整" : "凭据不完整"}</Badge>
            <Button type="button" variant="outline" disabled={!initial.alipay_configured} onClick={async () => {
              try { const result = await apiFetch<{ trace_id: string }>("/admin-api/alipay/test", { method: "POST" }); toast.success(`连接成功，Trace ${result.trace_id || "—"}`); }
              catch (error) { toast.error(error instanceof Error ? error.message : "连接失败"); }
            }}>测试连接</Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>商户 API</CardTitle><CardDescription>可分别停用旧版 MD5 和新版 RSA 接口；已有订单的通知仍按创建时的版本签名。</CardDescription></CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-4 rounded-md border p-4"><div><div className="text-sm font-medium">V1 MD5</div><p className="mt-1 text-xs text-muted">submit.php、mapi.php 与 api.php 查询。</p></div><Switch checked={v1Enabled} onCheckedChange={setV1Enabled} aria-label="启用 V1 API" /></div>
          <div className="flex items-center justify-between gap-4 rounded-md border p-4"><div><div className="text-sm font-medium">V2 RSA</div><p className="mt-1 text-xs text-muted">支付、订单查询与商户信息接口。</p></div><Switch checked={v2Enabled} onCheckedChange={setV2Enabled} aria-label="启用 V2 API" /></div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>公开地址</CardTitle><CardDescription>修改域名后请重新上传经营码，以更新图片绝对地址。</CardDescription></CardHeader>
        <CardContent><div className="space-y-2"><Label htmlFor="public-base">PUBLIC_BASE_URL</Label><Input id="public-base" type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} /></div></CardContent>
      </Card>

      <div className="flex justify-end"><Button size="lg" disabled={saving}>{saving ? "正在保存…" : "保存全部配置"}<Save /></Button></div>
    </form>
  );
}

export function SettingsPage() {
  const { data, isLoading, mutate } = useSWR<SettingsData>("/admin-api/settings", swrFetcher);
  if (isLoading || !data) return <Loading label="正在读取配置" />;
  return (
    <>
      <PageHeader title="收款配置" description="切换收款方式、配置支付宝 V3 和控制商户 API 开关。" />
      <SettingsForm initial={data} refresh={mutate} />
    </>
  );
}
