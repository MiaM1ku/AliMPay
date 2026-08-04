import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "@/web/lib/utils";

const badgeVariants = cva("inline-flex items-center rounded px-2 py-0.5 text-xs font-medium", {
  variants: {
    variant: {
      default: "bg-foreground/7 text-foreground",
      primary: "bg-primary/10 text-primary",
      success: "bg-success/10 text-success",
      danger: "bg-destructive/10 text-destructive",
      outline: "border text-muted",
    },
  },
  defaultVariants: { variant: "default" },
});

export function Badge({ className, variant, ...props }: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
