import {
  Activity,
  BookOpenText,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Menu,
  ReceiptText,
  Settings2,
  WalletCards,
} from "lucide-react";
import { useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { mutate } from "swr";
import { apiFetch } from "@/web/api";
import { Button } from "@/web/components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/web/components/ui/dialog";
import { cn } from "@/web/lib/utils";

const navigation = [
  { to: "/dashboard", label: "仪表盘", icon: LayoutDashboard },
  { to: "/orders", label: "订单", icon: ReceiptText },
  { to: "/settings", label: "收款配置", icon: Settings2 },
  { to: "/keys", label: "密钥中心", icon: KeyRound },
  { to: "/docs", label: "API 文档", icon: BookOpenText },
  { to: "/system", label: "系统状态", icon: Activity },
];

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const navigate = useNavigate();
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-16 items-center gap-3 border-b px-5">
        <span className="flex size-8 items-center justify-center rounded-md bg-primary text-background"><WalletCards className="size-4" /></span>
        <div>
          <div className="text-sm font-semibold">AliMPay</div>
          <div className="text-xs text-muted">单商户收款网关</div>
        </div>
      </div>
      <nav className="flex-1 space-y-1 p-3" aria-label="后台导航">
        {navigation.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            onClick={onNavigate}
            className={({ isActive }) => cn(
              "flex h-9 items-center gap-3 rounded-md px-3 text-sm font-medium text-muted transition-colors hover:bg-foreground/5 hover:text-foreground",
              isActive && "bg-primary/10 text-primary hover:bg-primary/10 hover:text-primary",
            )}
          >
            <item.icon className="size-4" />
            {item.label}
          </NavLink>
        ))}
      </nav>
      <div className="border-t p-3">
        <Button
          variant="ghost"
          className="w-full justify-start text-muted"
          onClick={async () => {
            await apiFetch("/admin-api/logout", { method: "POST" }).catch(() => undefined);
            await mutate(() => true, undefined, { revalidate: false });
            navigate("/login", { replace: true });
          }}
        >
          <LogOut />退出登录
        </Button>
      </div>
    </div>
  );
}

export function AppShell() {
  const [open, setOpen] = useState(false);
  return (
    <div className="min-h-screen bg-background">
      <aside className="fixed inset-y-0 left-0 hidden w-60 border-r lg:block">
        <SidebarContent />
      </aside>
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b bg-background/95 px-4 lg:hidden">
        <div className="flex items-center gap-2 text-sm font-semibold"><WalletCards className="size-4 text-primary" />AliMPay</div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="打开导航" title="打开导航"><Menu /></Button>
          </DialogTrigger>
          <DialogContent className="left-0 top-0 h-dvh w-72 max-w-none translate-x-0 translate-y-0 rounded-none border-y-0 border-l-0 p-0">
            <DialogTitle className="sr-only">后台导航</DialogTitle>
            <SidebarContent onNavigate={() => setOpen(false)} />
          </DialogContent>
        </Dialog>
      </header>
      <main className="lg:pl-60">
        <div className="mx-auto w-full max-w-[1440px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
