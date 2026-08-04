import { AlertTriangle, CircleDollarSign, Clock3, RefreshCw, Send, ShoppingCart } from "lucide-react";
import { Link } from "react-router-dom";
import useSWR from "swr";
import { toast } from "sonner";
import type { DashboardData } from "@/shared/contracts";
import { apiFetch, swrFetcher } from "@/web/api";
import { PageHeader } from "@/web/components/page-header";
import { StatusBadge } from "@/web/components/status-badge";
import { Badge } from "@/web/components/ui/badge";
import { Button } from "@/web/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/web/components/ui/card";
import { Loading } from "@/web/components/ui/loading";
import { formatDate, formatMoney } from "@/web/lib/utils";

export function DashboardPage() {
  const { data, isLoading, mutate } = useSWR<DashboardData>("/admin-api/dashboard", swrFetcher, { refreshInterval: 5_000 });
  if (isLoading || !data) return <Loading label="正在汇总订单" />;
  const metrics = [
    { label: "今日订单", value: String(data.today_order_count), note: `${data.today_paid_count} 笔已支付`, icon: ShoppingCart },
    { label: "今日实收", value: formatMoney(data.today_paid_cents), note: "按商户原始金额统计", icon: CircleDollarSign },
    { label: "正在监控", value: String(data.active_monitors), note: "最多持续 10 分钟", icon: Clock3 },
    { label: "通知失败", value: String(data.notify_failed_count), note: "自动尝试最多 10 次", icon: Send },
  ];

  return (
    <>
      <PageHeader
        title="仪表盘"
        description="查看实时订单、共享扫单器和商户通知的工作状态。"
        actions={
          <Button variant="outline" onClick={async () => {
            const result = await apiFetch<{ status: string; matched: number }>("/admin-api/scans/run", { method: "POST" });
            toast.success(result.status === "skipped" ? "当前没有需要监控的订单" : `扫描完成，匹配 ${result.matched} 笔`);
            await mutate();
          }}><RefreshCw />立即扫描</Button>
        }
      />

      {!data.configured ? (
        <div className="mb-6 flex flex-col gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex gap-3"><AlertTriangle className="mt-0.5 size-5 shrink-0 text-destructive" /><div><div className="text-sm font-semibold">收款配置尚未完成</div><p className="mt-1 text-sm text-muted">请配置当前收款模式所需信息，并补齐支付宝 V3 应用凭据。</p></div></div>
          <Button asChild size="sm"><Link to="/settings">前往配置</Link></Button>
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {metrics.map((metric) => (
          <Card key={metric.label}>
            <CardContent className="pt-5">
              <div className="flex items-start justify-between"><span className="text-sm text-muted">{metric.label}</span><metric.icon className="size-4 text-primary" /></div>
              <div className="mt-3 text-2xl font-semibold tracking-tight">{metric.value}</div>
              <p className="mt-1 text-xs text-muted">{metric.note}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[1fr_340px]">
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <div><CardTitle>最近订单</CardTitle><CardDescription>状态每 5 秒刷新一次。</CardDescription></div>
            <Button asChild variant="ghost" size="sm"><Link to="/orders">查看全部</Link></Button>
          </CardHeader>
          <CardContent>
            {data.recent_orders.length === 0 ? (
              <div className="py-12 text-center text-sm text-muted">还没有商户订单</div>
            ) : (
              <div className="overflow-x-auto scrollbar-thin">
                <table className="w-full min-w-[680px] text-left text-sm">
                  <thead className="border-b text-xs text-muted"><tr><th className="pb-3 font-medium">商户订单号</th><th className="pb-3 font-medium">商品</th><th className="pb-3 font-medium">金额</th><th className="pb-3 font-medium">状态</th><th className="pb-3 text-right font-medium">创建时间</th></tr></thead>
                  <tbody className="divide-y">
                    {data.recent_orders.map((order) => (
                      <tr key={order.id}>
                        <td className="py-3 font-mono text-xs"><Link className="hover:text-primary" to={`/orders/${order.id}`}>{order.out_trade_no}</Link></td>
                        <td className="max-w-48 truncate py-3">{order.name}</td>
                        <td className="py-3 font-mono">{formatMoney(order.requested_amount_cents)}</td>
                        <td className="py-3"><StatusBadge status={order.status} /></td>
                        <td className="py-3 text-right text-xs text-muted">{formatDate(order.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>共享扫单器</CardTitle><CardDescription>仅在存在有效监控订单时请求支付宝。</CardDescription></CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between text-sm"><span className="text-muted">当前收款模式</span><Badge variant="primary">{data.collection_mode === "business_qr" ? "经营码" : "转账备注"}</Badge></div>
            {data.last_scan ? (
              <>
                <div className="flex items-center justify-between text-sm"><span className="text-muted">上次结果</span><Badge variant={data.last_scan.status === "success" ? "success" : data.last_scan.status === "error" ? "danger" : "outline"}>{data.last_scan.status}</Badge></div>
                <div className="flex items-center justify-between text-sm"><span className="text-muted">扫描记录</span><span>{data.last_scan.records} 条 / 匹配 {data.last_scan.matched} 条</span></div>
                <div className="flex items-center justify-between text-sm"><span className="text-muted">完成时间</span><span className="text-xs">{formatDate(data.last_scan.finished_at)}</span></div>
                {data.last_scan.error ? <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs leading-5 text-destructive">{data.last_scan.error}</div> : null}
              </>
            ) : <div className="py-6 text-center text-sm text-muted">尚未执行扫描</div>}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
