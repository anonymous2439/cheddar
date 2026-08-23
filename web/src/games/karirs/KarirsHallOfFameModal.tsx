import { useEffect, useState } from "react";
import * as karirsApi from "../../api/karirs";
import type { KarirsHallOfFameEntry } from "../../types";

interface Props {
  onClose: () => void;
}

// The 10 biggest wagers that ever actually won, ranked by wager size (not
// payout) — queryable on demand from the game view, unlike the bet-placed
// and daily-bonus messages, which are announced automatically. A fixed
// record to check, not a live event to be notified about.
export function KarirsHallOfFameModal({ onClose }: Props) {
  const [entries, setEntries] = useState<KarirsHallOfFameEntry[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    karirsApi
      .getHallOfFame()
      .then((data) => {
        if (!cancelled) setEntries(data);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load the hall of fame");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-full max-w-sm rounded-lg bg-white p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-semibold">🏆 Hall of Fame</h3>
          <button onClick={onClose} className="text-neutral-400 hover:text-neutral-600" aria-label="Close">
            ✕
          </button>
        </div>
        <p className="mb-3 text-xs text-neutral-500">The biggest bets that ever actually won.</p>

        {error && <p className="text-sm text-red-600">{error}</p>}
        {!entries && !error && <p className="text-sm text-neutral-500">Loading…</p>}
        {entries && entries.length === 0 && <p className="text-sm text-neutral-500">No winning bets yet.</p>}

        {entries && entries.length > 0 && (
          <ol className="space-y-2 text-sm">
            {entries.map((entry, i) => (
              <li key={i} className="flex items-center justify-between gap-2 rounded border border-neutral-100 px-2 py-1.5">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="flex-shrink-0 font-semibold text-amber-600">#{i + 1}</span>
                  <span className="min-w-0 truncate">
                    <span className="font-medium">{entry.display_name}</span> bet {entry.wager} on {entry.racer_name}
                  </span>
                </span>
                <span className="flex-shrink-0 font-semibold text-green-700">+{entry.payout}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
