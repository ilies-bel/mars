import { Loader2Icon } from "lucide-react";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

export type LoaderProps = ComponentProps<typeof Loader2Icon>;

export const Loader = ({ className, size = 16, ...props }: LoaderProps) => (
  <Loader2Icon
    aria-label="Loading"
    className={cn("animate-spin text-muted-foreground", className)}
    role="status"
    size={size}
    {...props}
  />
);
