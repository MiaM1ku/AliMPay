import { AlertTriangle, Download, Eye, KeyRound, RefreshCw, Upload } from "lucide-react";
import { useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import type { PublicSettings } from "@/shared/contracts";
import { apiFetch, jsonBody, swrFetcher } from "@/web/api";
import { CopyButton } from "@/web/components/copy-button";
import { PageHeader } from "@/web/components/page-header";
import { Badge } from "@/web/components/ui/badge";
import { Button } from "@/web/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/web/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/web/components/ui/dialog";
import { Loading } from "@/web/components/ui/loading";
import { Textarea } from "@/web/components/ui/textarea";

interface KeySettings extends PublicSettings {
  alipay_app_public_key: string;
  has_alipay_private_key: boolean;
  has_v1_key: boolean;
  has_v2_platform_private_key: boolean;
}

interface KeyDisclosure {
  title: string;
  privateKey?: string;
  publicKey?: string;
  oneTime?: boolean;
}

interface Confirmation {
  title: string;
  description: string;
  action: () => Promise<void>;
}

function download(name: string, value: string) {
  const url = URL.createObjectURL(new Blob([value], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

function DisclosureDialog({ value, onClose }: { value: KeyDisclosure | null; onClose: () => void }) {
  return (
    <Dialog open={Boolean(value)} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogTitle>{value?.title}</DialogTitle>
        <DialogDescription>{value?.oneTime ? "私钥只在本次响应中展示，关闭前请复制并安全保存。" : "请将密钥存放在受控的密码管理器中。"}</DialogDescription>
        {value?.privateKey ? <div className="mt-4 space-y-2"><div className="text-xs font-medium">私钥（PKCS#8）</div><Textarea value={value.privateKey} readOnly rows={9} /><div className="flex gap-2"><CopyButton value={value.privateKey} label="复制私钥" /><Button variant="outline" size="sm" onClick={() => download("private-key.pem", value.privateKey!)}><Download />下载</Button></div></div> : null}
        {value?.publicKey ? <div className="mt-4 space-y-2"><div className="text-xs font-medium">公钥（SPKI）</div><Textarea value={value.publicKey} readOnly rows={6} /><CopyButton value={value.publicKey} label="复制公钥" /></div> : null}
      </DialogContent>
    </Dialog>
  );
}

function ConfirmationDialog({ value, onClose }: { value: Confirmation | null; onClose: () => void }) {
  const [working, setWorking] = useState(false);
  return (
    <Dialog open={Boolean(value)} onOpenChange={(open) => { if (!open && !working) onClose(); }}>
      <DialogContent>
        <DialogTitle>{value?.title}</DialogTitle>
        <DialogDescription>{value?.description}</DialogDescription>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" disabled={working} onClick={onClose}>取消</Button>
          <Button variant="danger" disabled={working} onClick={async () => {
            if (!value) return;
            setWorking(true);
            try { await value.action(); onClose(); } finally { setWorking(false); }
          }}>{working ? "正在处理…" : "确认轮换"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function KeyCenterPage() {
  const { data, isLoading, mutate } = useSWR<KeySettings>("/admin-api/settings", swrFetcher);
  const [disclosure, setDisclosure] = useState<KeyDisclosure | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [alipayPrivateImport, setAlipayPrivateImport] = useState("");
  const [merchantPublicImport, setMerchantPublicImport] = useState("");
  if (isLoading || !data) return <Loading label="正在读取密钥状态" />;

  async function call<T>(path: string, title: string) {
    try {
      const result = await apiFetch<T>(path, { method: "POST" });
      toast.success(title);
      await mutate();
      return result;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "操作失败");
      return null;
    }
  }

  return (
    <>
      <PageHeader title="密钥中心" description="三类协议凭据完全隔离；RSA 密钥统一使用 2048 位、PKCS#8 私钥与 SPKI 公钥。" />
      <div className="mb-6 flex gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm leading-6 text-muted"><AlertTriangle className="mt-0.5 size-5 shrink-0 text-destructive" /><div><span className="font-semibold text-foreground">不要复用密钥。</span> 支付宝应用密钥、易支付 V1 密钥、V2 平台密钥与 V2 商户密钥各自承担不同的信任方向。重新生成会使旧客户端签名失效。</div></div>

      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader><div className="flex items-center justify-between"><CardTitle>易支付 V1 · MD5</CardTitle><Badge variant={data.has_v1_key ? "success" : "danger"}>{data.has_v1_key ? "已配置" : "缺失"}</Badge></div><CardDescription>商户使用 PID 与 32 位 key 对请求签名。</CardDescription></CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-md border p-3"><div className="text-xs text-muted">商户 PID</div><div className="mt-1 font-mono text-sm">{data.merchant_pid || "—"}</div></div>
            <div className="rounded-md border p-3"><div className="text-xs text-muted">MD5 key</div><div className="mt-1 font-mono text-sm">{data.v1_key_masked || "—"}</div></div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={async () => {
                const result = await apiFetch<{ pid: string; key: string }>("/admin-api/keys/v1/reveal", { method: "POST" });
                setDisclosure({ title: "V1 商户凭据", privateKey: `PID=${result.pid}\nKEY=${result.key}` });
              }}><Eye />查看凭据</Button>
              <Button variant="danger" onClick={() => setConfirmation({
                title: "重新生成 V1 key",
                description: "旧 key 会立即失效，所有 V1 客户端都必须更新配置。",
                action: async () => {
                  const result = await call<{ pid: string; key: string }>("/admin-api/keys/v1/regenerate", "V1 key 已更新");
                  if (result) setDisclosure({ title: "新的 V1 商户凭据", privateKey: `PID=${result.pid}\nKEY=${result.key}` });
                },
              })}><RefreshCw />重新生成</Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><div className="flex items-center justify-between"><CardTitle>易支付 V2 · 平台密钥</CardTitle><Badge variant={data.has_v2_platform_private_key ? "success" : "danger"}>{data.has_v2_platform_private_key ? "已配置" : "缺失"}</Badge></div><CardDescription>平台私钥签名接口响应与支付通知，商户使用平台公钥验签。</CardDescription></CardHeader>
          <CardContent className="space-y-4">
            <Textarea value={data.v2_platform_public_key} readOnly rows={6} />
            <div className="flex flex-wrap gap-2"><CopyButton value={data.v2_platform_public_key} label="复制平台公钥" /><Button variant="danger" onClick={() => setConfirmation({
              title: "轮换 V2 平台密钥",
              description: "旧平台公钥会立即失效，所有 V2 商户都必须同步新公钥。",
              action: async () => {
                const result = await call<{ private_key: string; public_key: string }>("/admin-api/keys/v2/platform/regenerate", "V2 平台密钥已轮换");
                if (result) setDisclosure({ title: "新的 V2 平台密钥", privateKey: result.private_key, publicKey: result.public_key });
              },
            })}><RefreshCw />轮换密钥</Button></div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><div className="flex items-center justify-between"><CardTitle>易支付 V2 · 商户密钥</CardTitle><Badge variant={data.v2_merchant_public_key ? "success" : "danger"}>{data.v2_merchant_public_key ? "公钥已登记" : "未登记"}</Badge></div><CardDescription>商户私钥签名请求；服务端只保存商户公钥。</CardDescription></CardHeader>
          <CardContent className="space-y-4">
            {data.v2_merchant_public_key ? <Textarea value={data.v2_merchant_public_key} readOnly rows={5} /> : null}
            <Button onClick={async () => {
              const result = await call<{ private_key: string; public_key: string }>("/admin-api/keys/v2/merchant/generate", "商户密钥已生成");
              if (result) setDisclosure({ title: "V2 商户密钥", privateKey: result.private_key, publicKey: result.public_key, oneTime: true });
            }}><KeyRound />生成商户密钥对</Button>
            <div className="border-t pt-4"><div className="mb-2 text-xs font-medium">或导入已有商户公钥</div><Textarea value={merchantPublicImport} onChange={(event) => setMerchantPublicImport(event.target.value)} rows={5} placeholder="-----BEGIN PUBLIC KEY-----" /><Button className="mt-2" variant="outline" disabled={!merchantPublicImport} onClick={async () => {
              try { await apiFetch("/admin-api/keys/v2/merchant", { method: "PUT", ...jsonBody({ public_key: merchantPublicImport }) }); toast.success("商户公钥已导入"); setMerchantPublicImport(""); await mutate(); }
              catch (error) { toast.error(error instanceof Error ? error.message : "导入失败"); }
            }}><Upload />导入公钥</Button></div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><div className="flex items-center justify-between"><CardTitle>支付宝应用密钥</CardTitle><Badge variant={data.has_alipay_private_key ? "success" : "danger"}>{data.has_alipay_private_key ? "应用私钥已保存" : "未配置"}</Badge></div><CardDescription>应用私钥签名支付宝 V3 请求；应用公钥需上传到支付宝开放平台。</CardDescription></CardHeader>
          <CardContent className="space-y-4">
            {data.alipay_app_public_key ? <><Textarea value={data.alipay_app_public_key} readOnly rows={5} /><CopyButton value={data.alipay_app_public_key} label="复制应用公钥" /></> : null}
            <Button onClick={async () => {
              const result = await call<{ private_key: string; public_key: string }>("/admin-api/keys/alipay/generate", "支付宝应用密钥已生成");
              if (result) setDisclosure({ title: "支付宝应用密钥", privateKey: result.private_key, publicKey: result.public_key });
            }}><KeyRound />生成应用密钥</Button>
            <div className="border-t pt-4"><div className="mb-2 text-xs font-medium">或导入已有应用私钥</div><Textarea value={alipayPrivateImport} onChange={(event) => setAlipayPrivateImport(event.target.value)} rows={6} placeholder="-----BEGIN PRIVATE KEY-----" /><Button className="mt-2" variant="outline" disabled={!alipayPrivateImport} onClick={async () => {
              try { await apiFetch("/admin-api/keys/alipay/private", { method: "PUT", ...jsonBody({ private_key: alipayPrivateImport }) }); toast.success("应用私钥已导入"); setAlipayPrivateImport(""); await mutate(); }
              catch (error) { toast.error(error instanceof Error ? error.message : "导入失败"); }
            }}><Upload />导入私钥</Button></div>
          </CardContent>
        </Card>
      </div>
      <DisclosureDialog value={disclosure} onClose={() => setDisclosure(null)} />
      <ConfirmationDialog value={confirmation} onClose={() => setConfirmation(null)} />
    </>
  );
}
