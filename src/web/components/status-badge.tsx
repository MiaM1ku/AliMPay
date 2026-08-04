import type { OrderStatus } from "@/shared/contracts";
import { Badge } from "@/web/components/ui/badge";

const labels: Record<OrderStatus, string> = {
  pending: "等待支付",
  expired: "已过期",
  paid: "支付成功",
  late_paid: "迟到支付",
};

export function StatusBadge({ status }: { status: OrderStatus }) {
  const variant = status === "paid" ? "success" : status === "late_paid" ? "primary" : status === "expired" ? "danger" : "outline";
  return <Badge variant={variant}>{labels[status]}</Badge>;
}
