import type { ChatStatus, FileUIPart } from "ai";
import { Loader2Icon, SendIcon, SquareIcon, XIcon } from "lucide-react";
import {
  Children,
  Fragment,
  type ChangeEvent,
  type ComponentProps,
  type FormEvent,
  type FormEventHandler,
  type HTMLAttributes,
  type KeyboardEventHandler,
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export type PromptInputMessage = {
  text?: string;
  files?: FileUIPart[];
};

export type PromptInputAttachmentItem = FileUIPart & { id: string };

type AttachmentsContextValue = {
  files: PromptInputAttachmentItem[];
  add: (files: File[] | FileList) => void;
  remove: (id: string) => void;
  clear: () => void;
  openFileDialog: () => void;
};

const AttachmentsContext = createContext<AttachmentsContextValue | null>(null);

export const usePromptInputAttachments = () => {
  const context = useContext(AttachmentsContext);
  if (!context) {
    throw new Error(
      "usePromptInputAttachments must be used within a PromptInput"
    );
  }
  return context;
};

const createAttachmentId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);

export type PromptInputProps = Omit<
  HTMLAttributes<HTMLFormElement>,
  "onSubmit"
> & {
  accept?: string;
  multiple?: boolean;
  onSubmit?: (
    message: PromptInputMessage,
    event: FormEvent<HTMLFormElement>
  ) => void;
};

export const PromptInput = ({
  className,
  accept,
  multiple = true,
  onSubmit,
  children,
  ...props
}: PromptInputProps) => {
  const [items, setItems] = useState<PromptInputAttachmentItem[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const add = useCallback((files: File[] | FileList) => {
    const incoming = Array.from(files);
    setItems((prev) => [
      ...prev,
      ...incoming.map((file) => ({
        id: createAttachmentId(),
        type: "file" as const,
        url: URL.createObjectURL(file),
        mediaType: file.type,
        filename: file.name,
      })),
    ]);
  }, []);

  const remove = useCallback((id: string) => {
    setItems((prev) => {
      const found = prev.find((item) => item.id === id);
      if (found?.url) {
        URL.revokeObjectURL(found.url);
      }
      return prev.filter((item) => item.id !== id);
    });
  }, []);

  const clear = useCallback(() => {
    setItems((prev) => {
      for (const item of prev) {
        if (item.url) {
          URL.revokeObjectURL(item.url);
        }
      }
      return [];
    });
  }, []);

  const openFileDialog = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      if (event.target.files) {
        add(event.target.files);
      }
      event.target.value = "";
    },
    [add]
  );

  const handleSubmit: FormEventHandler<HTMLFormElement> = (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const textarea = form.querySelector("textarea");
    const text = textarea?.value ?? "";
    onSubmit?.(
      {
        text,
        files: items.map((item) => ({
          type: item.type,
          url: item.url,
          mediaType: item.mediaType,
          filename: item.filename,
        })),
      },
      event
    );
  };

  const contextValue = useMemo<AttachmentsContextValue>(
    () => ({ files: items, add, remove, clear, openFileDialog }),
    [items, add, remove, clear, openFileDialog]
  );

  return (
    <AttachmentsContext.Provider value={contextValue}>
      <form
        className={cn(
          "w-full divide-y overflow-hidden rounded-xl border bg-background shadow-sm",
          className
        )}
        onSubmit={handleSubmit}
        {...props}
      >
        <input
          accept={accept}
          className="hidden"
          multiple={multiple}
          onChange={handleFileChange}
          ref={fileInputRef}
          type="file"
        />
        {children}
      </form>
    </AttachmentsContext.Provider>
  );
};

export type PromptInputBodyProps = HTMLAttributes<HTMLDivElement>;

export const PromptInputBody = ({
  className,
  ...props
}: PromptInputBodyProps) => (
  <div className={cn("flex flex-col", className)} {...props} />
);

export type PromptInputAttachmentsProps = HTMLAttributes<HTMLDivElement> & {
  children: (attachment: PromptInputAttachmentItem) => ReactNode;
};

export const PromptInputAttachments = ({
  className,
  children,
  ...props
}: PromptInputAttachmentsProps) => {
  const attachments = usePromptInputAttachments();

  if (attachments.files.length === 0) {
    return null;
  }

  return (
    <div className={cn("flex flex-wrap gap-2 p-3", className)} {...props}>
      {attachments.files.map((file) => (
        <Fragment key={file.id}>{children(file)}</Fragment>
      ))}
    </div>
  );
};

export type PromptInputAttachmentProps = HTMLAttributes<HTMLDivElement> & {
  data: PromptInputAttachmentItem;
};

export const PromptInputAttachment = ({
  data,
  className,
  ...props
}: PromptInputAttachmentProps) => {
  const attachments = usePromptInputAttachments();

  return (
    <div
      className={cn(
        "group relative flex items-center gap-2 rounded-md border bg-accent/50 py-1 pr-1 pl-2 text-xs",
        className
      )}
      {...props}
    >
      {data.mediaType?.startsWith("image/") && data.url ? (
        <img
          alt={data.filename ?? "attachment"}
          className="size-8 rounded object-cover"
          src={data.url}
        />
      ) : (
        <span className="max-w-40 truncate">
          {data.filename ?? "attachment"}
        </span>
      )}
      <Button
        aria-label="Remove attachment"
        className="size-5"
        onClick={() => attachments.remove(data.id)}
        size="icon"
        type="button"
        variant="ghost"
      >
        <XIcon className="size-3" />
      </Button>
    </div>
  );
};

export type PromptInputTextareaProps = ComponentProps<typeof Textarea>;

export const PromptInputTextarea = ({
  className,
  onKeyDown,
  placeholder = "What would you like to know?",
  ...props
}: PromptInputTextareaProps) => {
  const handleKeyDown: KeyboardEventHandler<HTMLTextAreaElement> = (event) => {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
    onKeyDown?.(event);
  };

  return (
    <Textarea
      className={cn(
        "w-full resize-none rounded-none border-none bg-transparent p-3 shadow-none outline-none ring-0 focus-visible:ring-0",
        className
      )}
      name="message"
      onKeyDown={handleKeyDown}
      placeholder={placeholder}
      {...props}
    />
  );
};

export type PromptInputToolbarProps = HTMLAttributes<HTMLDivElement>;

export const PromptInputToolbar = ({
  className,
  ...props
}: PromptInputToolbarProps) => (
  <div
    className={cn("flex items-center justify-between p-1", className)}
    {...props}
  />
);

export type PromptInputToolsProps = HTMLAttributes<HTMLDivElement>;

export const PromptInputTools = ({
  className,
  ...props
}: PromptInputToolsProps) => (
  <div
    className={cn(
      "flex items-center gap-1",
      "[&_button:first-child]:rounded-bl-xl",
      className
    )}
    {...props}
  />
);

export type PromptInputButtonProps = ComponentProps<typeof Button>;

export const PromptInputButton = ({
  className,
  variant = "ghost",
  size,
  children,
  ...props
}: PromptInputButtonProps) => {
  const resolvedSize = size ?? (Children.count(children) > 1 ? "default" : "icon");

  return (
    <Button
      className={cn(
        "shrink-0 gap-1.5 rounded-lg text-muted-foreground",
        variant === "ghost" && "hover:bg-accent",
        className
      )}
      size={resolvedSize}
      type="button"
      variant={variant}
      {...props}
    >
      {children}
    </Button>
  );
};

export type PromptInputSubmitProps = ComponentProps<typeof Button> & {
  status?: ChatStatus;
};

export const PromptInputSubmit = ({
  className,
  variant = "default",
  size = "icon",
  status,
  children,
  ...props
}: PromptInputSubmitProps) => {
  let icon: ReactNode = <SendIcon className="size-4" />;

  if (status === "submitted") {
    icon = <Loader2Icon className="size-4 animate-spin" />;
  } else if (status === "streaming") {
    icon = <SquareIcon className="size-4" />;
  } else if (status === "error") {
    icon = <XIcon className="size-4" />;
  }

  return (
    <Button
      className={cn("gap-1.5 rounded-lg", className)}
      size={size}
      type="submit"
      variant={variant}
      {...props}
    >
      {children ?? icon}
    </Button>
  );
};
