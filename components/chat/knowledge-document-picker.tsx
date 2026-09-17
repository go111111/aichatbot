"use client";

import { CheckIcon, LibraryIcon, SearchIcon } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useActiveChat } from "@/hooks/use-active-chat";
import type { KnowledgeFile } from "@/lib/types";
import { cn } from "@/lib/utils";

type KnowledgeFilesResponse = {
  files: KnowledgeFile[];
};

const fetchKnowledgeFiles = async (url: string) => {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error("Failed to load knowledge files");
  }

  return response.json() as Promise<KnowledgeFilesResponse>;
};

function isSelectable(file: KnowledgeFile) {
  return file.status === "ready" && file.parseStatus === "parsed";
}

export function KnowledgeDocumentPicker() {
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
  const [query, setQuery] = useState("");
  const { selectedDocumentIds, setSelectedDocumentIds } = useActiveChat();
  const { data, isLoading } = useSWR<KnowledgeFilesResponse>(
    `${basePath}/api/knowledge/files`,
    fetchKnowledgeFiles,
    { revalidateOnFocus: false }
  );
  const files = data?.files ?? [];
  const selectableFiles = files.filter(isSelectable);
  const filteredFiles = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    if (!normalizedQuery) {
      return selectableFiles;
    }

    return selectableFiles.filter((file) =>
      file.name.toLowerCase().includes(normalizedQuery)
    );
  }, [query, selectableFiles]);

  const toggleDocument = (id: string) => {
    setSelectedDocumentIds((currentIds) =>
      currentIds.includes(id)
        ? currentIds.filter((currentId) => currentId !== id)
        : [...currentIds, id]
    );
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          className="gap-1.5 rounded-lg border-border/50 text-muted-foreground shadow-none transition-colors hover:text-foreground focus-visible:border-border/50 focus-visible:ring-0 active:translate-y-0"
          size="sm"
          type="button"
          variant="outline"
        >
          <LibraryIcon className="size-3.5" />
          <span className="hidden sm:inline">Knowledge</span>
          {selectedDocumentIds.length > 0 && (
            <span className="ml-0.5 rounded-full bg-primary px-1.5 py-0.5 text-[10px] text-primary-foreground">
              {selectedDocumentIds.length}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-3">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="font-medium text-sm">Use knowledge</div>
          <Link
            className="text-muted-foreground text-xs hover:text-foreground"
            href="/knowledge"
          >
            Manage
          </Link>
        </div>
        <div className="relative mb-3">
          <SearchIcon className="-translate-y-1/2 absolute top-1/2 left-3 size-3.5 text-muted-foreground" />
          <Input
            className="h-8 rounded-lg pl-8 text-xs"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search documents"
            value={query}
          />
        </div>
        <div className="max-h-64 overflow-y-auto">
          {isLoading && (
            <div className="px-2 py-4 text-muted-foreground text-sm">
              Loading documents...
            </div>
          )}
          {!isLoading && filteredFiles.length === 0 && (
            <div className="px-2 py-4 text-muted-foreground text-sm">
              No ready documents
            </div>
          )}
          {filteredFiles.map((file) => {
            const selected = selectedDocumentIds.includes(file.id);

            return (
              <button
                className={cn(
                  "flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm transition-colors hover:bg-muted",
                  selected && "bg-muted"
                )}
                key={file.id}
                onClick={() => toggleDocument(file.id)}
                type="button"
              >
                <span
                  className={cn(
                    "flex size-4 shrink-0 items-center justify-center rounded border",
                    selected
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border"
                  )}
                >
                  {selected && <CheckIcon className="size-3" />}
                </span>
                <span className="min-w-0 flex-1 truncate">{file.name}</span>
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
