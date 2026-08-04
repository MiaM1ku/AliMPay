import * as React from "react";
import { cn } from "@/web/lib/utils";

export function Textarea({ className, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        "flex min-h-24 w-full rounded-md border bg-transparent px-3 py-2 font-mono text-xs leading-5 placeholder:font-sans placeholder:text-muted disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
