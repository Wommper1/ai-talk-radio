import { Clock, Trash2, Radio, VolumeX } from "lucide-react";
import type { Show } from "../types";
import { formatDate, formatTime } from "../lib/api";
import { Button } from "./ui";

interface Props {
  shows: Show[];
  onOpen: (show: Show) => void;
  onDelete: (show: Show) => void;
  onNew: () => void;
}

export function Library({ shows, onOpen, onDelete, onNew }: Props) {
  if (shows.length === 0) {
    return (
      <div className="mx-auto flex max-w-md flex-col items-center gap-4 px-5 py-24 text-center">
        <Radio size={34} className="text-[var(--color-line-bright)]" />
        <h2 className="font-serif text-2xl text-white">Nothing recorded yet</h2>
        <p className="text-sm leading-relaxed text-[var(--color-mute)]">
          Every show you generate is saved to the <span className="font-mono text-xs">shows</span> folder in the
          project and will show up here.
        </p>
        <Button variant="primary" onClick={onNew}>
          <Radio size={15} />
          Go to the studio
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-5 py-6">
      <div className="mb-5 flex items-baseline justify-between">
        <h2 className="font-serif text-2xl text-white">Library</h2>
        <span className="font-mono text-xs text-[var(--color-mute)]">
          {shows.length} show{shows.length === 1 ? "" : "s"}
        </span>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {shows.map((show) => (
          <article
            key={show.id}
            className="group overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] transition-colors hover:border-[var(--color-line-bright)]"
          >
            <button onClick={() => onOpen(show)} className="block w-full text-left">
              <img
                src={show.coverUrl}
                alt=""
                loading="lazy"
                className="aspect-square w-full bg-[var(--color-panel-2)] object-cover"
              />
              <div className="p-4">
                <h3 className="line-clamp-2 font-serif text-lg leading-snug text-white">{show.title}</h3>
                <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-[var(--color-mute)]">{show.summary}</p>

                <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--color-mute)]">
                  <span className="inline-flex items-center gap-1">
                    {show.hasAudio ? <Clock size={11} /> : <VolumeX size={11} />}
                    {show.hasAudio ? formatTime(show.duration) : "no audio"}
                  </span>
                  <span>{formatDate(show.createdAt)}</span>
                  <span className="text-[var(--color-amber)]">{show.style}</span>
                </div>
              </div>
            </button>

            <div className="flex items-center justify-between border-t border-[var(--color-line)] px-4 py-2">
              <span className="truncate font-mono text-[10px] text-[var(--color-mute)]">
                {show.hosts.map((h) => h.name).join(" · ")}
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(show);
                }}
                aria-label={`Delete ${show.title}`}
                className="opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
              >
                <Trash2 size={13} />
              </Button>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
