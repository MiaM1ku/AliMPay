import * as LabelPrimitive from "@radix-ui/react-label";
import * as React from "react";
import { cn } from "@/web/lib/utils";

export function Label({ className, ...props }: React.ComponentProps<typeof LabelPrimitive.Root>) {
  return <LabelPrimitive.Root className={cn("text-sm font-medium leading-none", className)} {...props} />;
}
