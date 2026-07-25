import { type ComponentProps, memo } from "react";
import { Ticket } from "lucide-react";
import { Streamdown } from "streamdown";

import { cn } from "@/lib/utils";

export type ResponseProps = ComponentProps<typeof Streamdown>;

/**
 * Custom Streamdown `components` that renders `#/task/<id>` anchors as inline
 * ticket chips instead of plain underlined links.  All other anchors keep the
 * default anchor rendering.
 */
const taskLinkComponents: ResponseProps["components"] = {
  a({ href, children, node: _node, ...rest }) {
    if (href?.startsWith("#/task/")) {
      return (
        <a
          href={href}
          className="inline-flex items-center gap-1 font-mono text-xs px-1.5 py-0.5 rounded border border-border bg-secondary text-secondary-foreground no-underline cursor-pointer hover:bg-secondary/80 hover:text-foreground"
        >
          <Ticket className="h-3 w-3 shrink-0" />
          {children}
        </a>
      );
    }
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    );
  },
};

export const Response = memo(
  ({ className, components, ...props }: ResponseProps) => (
    <Streamdown
      className={cn(
        "size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        className
      )}
      components={{ ...taskLinkComponents, ...components }}
      {...props}
    />
  ),
  (prevProps, nextProps) => prevProps.children === nextProps.children
);

Response.displayName = "Response";
