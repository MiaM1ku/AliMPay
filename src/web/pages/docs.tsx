import { ExternalLink, ShieldCheck } from "lucide-react";
import { useState } from "react";
import useSWR from "swr";
import { CopyButton } from "@/web/components/copy-button";
import { PageHeader } from "@/web/components/page-header";
import { Badge } from "@/web/components/ui/badge";
import { Button } from "@/web/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/web/components/ui/card";
import { Loading } from "@/web/components/ui/loading";
import { swrFetcher } from "@/web/api";
import { cn } from "@/web/lib/utils";

interface DocsData {
  base_url: string;
  pid: string;
  pay_type: string;
  v1: Record<string, string | number>;
  v2: Record<string, string | number>;
}

function Endpoint({ method, path, description }: { method: string; path: string; description: string }) {
  return <div className="grid gap-2 border-t py-3 sm:grid-cols-[64px_1fr_180px] sm:items-center"><Badge variant={method === "POST" ? "primary" : "outline"}>{method}</Badge><code className="break-all font-mono text-xs">{path}</code><span className="text-xs text-muted sm:text-right">{description}</span></div>;
}

export function DocsPage() {
  const { data, isLoading } = useSWR<DocsData>("/admin-api/docs", swrFetcher);
  const [version, setVersion] = useState<"v1" | "v2">("v2");
  if (isLoading || !data) return <Loading label="正在生成接口文档" />;
  const v1Example = `pid=${data.pid}&type=alipay&out_trade_no=ORDER10001&notify_url=${data.base_url}/example-notify&name=Test&money=1.00`;
  const v2Example = `pid=${data.pid}&method=web&type=alipay&out_trade_no=ORDER10001&notify_url=${data.base_url}/example-notify&name=Test&money=1.00&clientip=203.0.113.10&timestamp=${Math.floor(Date.now() / 1_000)}`;

  return (
    <>
      <PageHeader title="API 文档" description="当前实例的接入地址与签名规则。只支持支付宝收款，不提供退款、代付、关单或结算接口。" />
      <div className="mb-6 flex w-fit rounded-md border p-1" role="tablist" aria-label="协议版本">
        <Button type="button" size="sm" variant={version === "v2" ? "default" : "ghost"} onClick={() => setVersion("v2")}>V2 RSA</Button>
        <Button type="button" size="sm" variant={version === "v1" ? "default" : "ghost"} onClick={() => setVersion("v1")}>V1 MD5</Button>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
        <div className="space-y-6">
          <Card>
            <CardHeader><CardTitle>{version === "v2" ? "V2 RSA 接口" : "V1 兼容接口"}</CardTitle><CardDescription>基础地址：<code className="font-mono">{data.base_url}</code></CardDescription></CardHeader>
            <CardContent>
              {version === "v2" ? (
                <>
                  <Endpoint method="GET/POST" path="/api/pay/submit" description="页面跳转支付" />
                  <Endpoint method="POST" path="/api/pay/create" description="统一下单" />
                  <Endpoint method="POST" path="/api/pay/query" description="订单查询" />
                  <Endpoint method="POST" path="/api/merchant/info" description="商户信息" />
                  <Endpoint method="POST" path="/api/merchant/orders" description="订单列表" />
                </>
              ) : (
                <>
                  <Endpoint method="GET/POST" path="/submit.php" description="页面跳转支付" />
                  <Endpoint method="POST" path="/mapi.php" description="API 下单" />
                  <Endpoint method="GET/POST" path="/api.php?act=query" description="商户信息" />
                  <Endpoint method="GET/POST" path="/api.php?act=order" description="订单查询" />
                  <Endpoint method="GET/POST" path="/api.php?act=orders" description="订单列表" />
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>签名规则</CardTitle><CardDescription>参数值不做 URL 编码后再签名；请求传输时再按表单规则编码。</CardDescription></CardHeader>
            <CardContent className="space-y-4 text-sm leading-6">
              <ol className="list-decimal space-y-2 pl-5 text-muted"><li>取所有非空标量参数，排除数组、文件、<code className="font-mono">sign</code> 与 <code className="font-mono">sign_type</code>。</li><li>按参数名 ASCII 升序排列，并用 <code className="font-mono">key=value&amp;key=value</code> 连接。</li><li>{version === "v2" ? "使用商户 PKCS#8 私钥执行 SHA256WithRSA（PKCS#1 v1.5），Base64 作为 sign；timestamp 允许前后 300 秒。" : "把 V1 key 直接追加在待签名字符串末尾，计算小写 MD5。"}</li></ol>
              <div className="rounded-md border bg-foreground/[0.025] p-3"><div className="mb-2 flex items-center justify-between"><span className="text-xs font-medium">待签名示例</span><CopyButton value={version === "v2" ? v2Example : v1Example} /></div><code className="block whitespace-pre-wrap break-all font-mono text-xs leading-5">{version === "v2" ? v2Example : v1Example}</code></div>
              {version === "v2" ? <p className="flex gap-2 text-xs text-muted"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" />成功响应与支付通知均由平台私钥签名，请使用密钥中心显示的平台公钥验签。</p> : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>订单查询与通知</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm leading-6 text-muted">
              <p>订单查询优先返回本地状态。若订单仍在 10 分钟监控窗口内、且最近一次扫描已超过后台配置的支付轮询间隔，会合并触发一次支付宝查询，最多等待约 3 秒。</p>
              <p>异步通知使用 GET。商户必须校验签名和 <code className="font-mono">trade_status=TRADE_SUCCESS</code>，处理成功后以 2xx 响应返回纯文本 <code className="font-mono">success</code>。</p>
              <p>收银台 5 分钟过期；第 5–10 分钟发现的支付记为迟到支付，但外部接口仍返回 <code className="font-mono">status=1</code> 并正常通知。</p>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card><CardHeader><CardTitle>实例凭据</CardTitle></CardHeader><CardContent className="space-y-3"><div><div className="text-xs text-muted">PID</div><div className="mt-1 font-mono text-sm">{data.pid}</div></div><CopyButton value={data.pid} label="复制 PID" /></CardContent></Card>
          <Card><CardHeader><CardTitle>上游参考</CardTitle><CardDescription>协议细节以官方文档为准。</CardDescription></CardHeader><CardContent className="space-y-3 text-sm">
            <a className="flex items-center justify-between hover:text-primary" href="https://opendocs.alipay.com/open-v3/26ed84be_alipay.data.bill.accountlog.query" target="_blank" rel="noreferrer">支付宝 V3 账务明细<ExternalLink className="size-4" /></a>
            <a className="flex items-center justify-between hover:text-primary" href="https://opendocs.alipay.com/common/055l5k" target="_blank" rel="noreferrer">支付宝应用私钥说明<ExternalLink className="size-4" /></a>
          </CardContent></Card>
        </div>
      </div>
    </>
  );
}
