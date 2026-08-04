import * as SwitchPrimitive from "@radix-ui/react-switch";
import * as React from "react";
import { cn } from "@/web/lib/utils";

export function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn("inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent bg-foreground/15 transition-colors data-[state=checked]:bg-primary", className)}
      {...props}
    >
      <SwitchPrimitive.Thumb className="pointer-events-none block size-4 translate-x-0 rounded-full bg-background transition-transform data-[state=checked]:translate-x-4" />
    </SwitchPrimitive.Root>
  );
}
