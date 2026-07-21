import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

export type ImageProps = ComponentProps<"img"> & {
  base64?: string;
  mediaType?: string;
};

export const Image = ({
  base64,
  mediaType,
  className,
  alt,
  src,
  ...props
}: ImageProps) => (
  <img
    {...props}
    alt={alt}
    className={cn(
      "h-auto max-w-full overflow-hidden rounded-md",
      className
    )}
    src={
      src ?? (base64 && mediaType ? `data:${mediaType};base64,${base64}` : undefined)
    }
  />
);
