import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { Button, type ButtonProps } from "@/web/components/ui/button";

export function CopyButton({ value, label = "复制", ...props }: { value: string; label?: string } & Omit<ButtonProps, "onClick">) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      {...props}
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1_500);
      }}
    >
      {copied ? <Check /> : <Copy />}
      {copied ? "已复制" : label}
    </Button>
  );
}
