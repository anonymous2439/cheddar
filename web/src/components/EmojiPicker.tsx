import { useEffect, useRef } from "react";
import { EMOJI_PICKER_LIST } from "../lib/emoji";

interface Props {
  onSelect: (emoji: string) => void;
  onClose: () => void;
}

export function EmojiPicker({ onSelect, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="absolute bottom-full left-0 mb-2 grid max-h-56 w-64 grid-cols-8 gap-1 overflow-y-auto rounded-lg border border-neutral-200 bg-white p-2 shadow-lg"
    >
      {EMOJI_PICKER_LIST.map((emoji) => (
        <button
          key={emoji}
          type="button"
          onClick={() => onSelect(emoji)}
          className="rounded p-1 text-lg leading-none hover:bg-neutral-100"
        >
          {emoji}
        </button>
      ))}
    </div>
  );
}
