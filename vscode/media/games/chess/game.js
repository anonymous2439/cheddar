// Chess — vscode client module, vendored into the Cheddar extension.
//
// The server (main Cheddar API's /api/v1/chess, backed by python-chess) is
// the sole authority on legal moves and game-end conditions — this client
// carries no chess rules of its own, and typed moves ("Nf3") are sent as
// plain text for the server to parse as standard algebraic notation. That's
// also why there's no legal-move highlighting on the board: doing that
// properly needs a real move generator, which would mean depending on
// something like chess.js and adding a bundler this module doesn't
// otherwise need (see build.sh) — an illegal attempt just gets rejected
// with a message instead.
//
// Default view is a "terminal": a scrollable move-history list plus a text
// input, so the game is fully playable without ever touching the board.
// The board is built once and kept around (just hidden via CSS) rather than
// torn down and rebuilt — same reasoning as the "Show/Hide" toggle not
// destroying it: rebuilding 64 click handlers on every render is wasted
// work, and it's what caused the input-losing-focus-and-typed-text problem
// this whole module works around by only ever updating existing elements
// in render(), never wiping innerHTML after the initial build.
(function () {
    const PIECE_CHARS = {
        K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘', P: '♙',
        k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟',
    };

    // Purely a client-side cosmetic preference (see window.CheddarHost's
    // getPreference/setPreference in chat.js) — not synced to the backend
    // or the other player, same as the web app's own board-theme picker
    // (web/src/games/chess/boardThemes.ts, kept in sync with these same
    // color values/ids by hand since this module has no bundler to import
    // that file through). "classic" (null/null) keeps this module's
    // original outline-only look as the default, matching every other
    // theme choice being additive, not a replacement of what shipped before.
    const BOARD_THEMES = {
        classic: { label: 'Classic', light: null, dark: null },
        green: { label: 'Green', light: '#eeeed2', dark: '#769656' },
        blue: { label: 'Blue', light: '#dee3e6', dark: '#8ca2ad' },
        wood: { label: 'Wood', light: '#f0d9b5', dark: '#b58863' },
        gray: { label: 'Gray', light: '#e8e8e8', dark: '#8a8a8a' },
    };
    // Same tint the web app uses for "last move" highlighting — a muted
    // olive-yellow, deliberately more subdued than a vivid/neon yellow (an
    // earlier, brighter version was too strong).
    const LAST_MOVE_HIGHLIGHT = '#cdd26a';

    let ctx = null;
    let container = null;
    let state = null;
    let selectedSquare = null;
    let errorText = '';
    let showBoard = false;
    let awaitingMove = false;
    let boardTheme = 'classic';

    // Built once per mount() in buildChrome(); render() only ever updates
    // these, never recreates them — see the file-level comment above.
    let statusEl = null;
    let boardToggleBtn = null;
    let themeSelectEl = null;
    let boardWrapEl = null;
    let squareEls = {}; // squareName ('e4') -> its persistent div
    let movesListEl = null;
    let moveInputEl = null;
    let moveSendBtn = null;
    let moveErrorEl = null;
    let resignBtnEl = null;

    function mount(el, mountCtx) {
        container = el;
        ctx = mountCtx;
        state = null;
        selectedSquare = null;
        errorText = '';
        showBoard = false;
        awaitingMove = false;
        boardTheme = window.CheddarHost.getPreference('chess.boardTheme', 'classic');
        squareEls = {};

        buildChrome();
        render();
        window.CheddarHost.send('get_state', { lobbyId: ctx.lobbyId });
    }

    function unmount() {
        container = null;
        statusEl = boardToggleBtn = themeSelectEl = boardWrapEl = movesListEl = null;
        moveInputEl = moveSendBtn = moveErrorEl = resignBtnEl = null;
        squareEls = {};
    }

    function onEvent(event, data) {
        // Moves arrive here even if this module were somehow inactive — the
        // host always forwards them (see extension.ts's
        // handleChessMoveEvent) — but render() itself no-ops without a
        // container, so that's harmless.
        if (event === 'state') {
            state = data;
            selectedSquare = null;
            errorText = '';
            awaitingMove = false;
            if (moveInputEl) moveInputEl.value = '';
        } else if (event === 'error') {
            errorText = data.message;
            awaitingMove = false;
        }
        render();
    }

    function myColor() {
        if (!state || !ctx) return null;
        if (ctx.selfId === state.white_user_id) return 'white';
        if (ctx.selfId === state.black_user_id) return 'black';
        return null;
    }

    // FEN's board field, rank 8 first — grid[0] is rank 8, grid[7] is rank
    // 1; within a row, grid[r][0] is file a.
    function parseFen(fen) {
        return fen.split(' ')[0].split('/').map((row) => {
            const cells = [];
            for (const ch of row) {
                if (/[1-8]/.test(ch)) {
                    for (let i = 0; i < Number(ch); i++) cells.push(null);
                } else {
                    cells.push(ch);
                }
            }
            return cells;
        });
    }

    function squareCoords(squareName) {
        return { fileIdx: squareName.charCodeAt(0) - 97, rankIdx: 8 - Number(squareName[1]) };
    }

    function pieceAt(grid, squareName) {
        const { rankIdx, fileIdx } = squareCoords(squareName);
        return grid[rankIdx][fileIdx];
    }

    function statusText() {
        if (!state) return 'loading…';
        const color = myColor();
        const aiSuffix = state.ai_skill_level != null ? ` · vs AI (skill ${state.ai_skill_level})` : '';
        if (state.status === 'in_progress') {
            if (!color) return (state.turn === 'white' ? 'White to move' : 'Black to move') + aiSuffix;
            const isMyTurn = color === state.turn;
            let t = isMyTurn ? 'Your move' : 'Waiting for opponent';
            if (state.is_check) t += isMyTurn ? ' — you are in check' : ' (check)';
            return t + aiSuffix;
        }
        if (state.status === 'checkmate') {
            if (!color) return 'Checkmate';
            return state.winner_user_id === ctx.selfId ? 'Checkmate — you win!' : 'Checkmate — you lose';
        }
        if (state.status === 'resigned') {
            if (!color) return 'A player resigned';
            return state.winner_user_id === ctx.selfId ? 'Opponent resigned — you win!' : 'You resigned';
        }
        if (state.status === 'stalemate') return 'Stalemate — draw';
        if (state.status === 'draw') return 'Draw';
        return '';
    }

    function sendMove(moveText) {
        errorText = '';
        awaitingMove = true;
        render();
        window.CheddarHost.send('move', { lobbyId: ctx.lobbyId, move: moveText });
    }

    function submitTypedMove() {
        const text = moveInputEl.value.trim();
        if (!text || !state || state.status !== 'in_progress') return;
        const color = myColor();
        if (!color || color !== state.turn) {
            errorText = "it's not your turn";
            render();
            return;
        }
        sendMove(text);
    }

    function handleSquareClick(squareName) {
        if (!state || state.status !== 'in_progress' || awaitingMove) return;
        const color = myColor();
        if (!color || color !== state.turn) return;

        const grid = parseFen(state.fen);
        const piece = pieceAt(grid, squareName);
        const pieceColor = piece ? (piece === piece.toUpperCase() ? 'white' : 'black') : null;

        if (!selectedSquare) {
            if (pieceColor === color) {
                selectedSquare = squareName;
                render();
            }
            return;
        }

        if (selectedSquare === squareName) {
            selectedSquare = null;
            render();
            return;
        }

        // Clicking another one of your own pieces re-selects instead of
        // firing off a move that the server would just reject anyway.
        if (pieceColor === color) {
            selectedSquare = squareName;
            render();
            return;
        }

        const from = selectedSquare;
        const to = squareName;
        selectedSquare = null;

        // No local legality check means no local promotion-choice UI either
        // — same simplification the web client makes: a pawn reaching the
        // back rank always promotes to queen. Sent as UCI (the server's
        // parser accepts either UCI or SAN — see _parse_move_text).
        let uci = from + to;
        const fromPiece = pieceAt(grid, from);
        if (fromPiece && fromPiece.toLowerCase() === 'p' && (to[1] === '8' || to[1] === '1')) {
            uci += 'q';
        }
        sendMove(uci);
    }

    // Built once — everything after this only ever updates these elements'
    // content/visibility, never recreates them (see the file-level comment).
    function buildChrome() {
        container.innerHTML = '';

        const title = document.createElement('p');
        title.style.fontWeight = '600';
        title.textContent = `♟️ ${ctx.gameName}`;
        container.appendChild(title);

        statusEl = document.createElement('p');
        container.appendChild(statusEl);

        boardToggleBtn = document.createElement('button');
        boardToggleBtn.type = 'button';
        boardToggleBtn.textContent = 'Show Board';
        boardToggleBtn.addEventListener('click', () => {
            showBoard = !showBoard;
            boardToggleBtn.textContent = showBoard ? 'Hide Board' : 'Show Board';
            boardWrapEl.style.display = showBoard ? 'grid' : 'none';
        });
        container.appendChild(boardToggleBtn);

        themeSelectEl = document.createElement('select');
        themeSelectEl.style.marginLeft = '6px';
        for (const id in BOARD_THEMES) {
            const opt = document.createElement('option');
            opt.value = id;
            opt.textContent = BOARD_THEMES[id].label;
            themeSelectEl.appendChild(opt);
        }
        themeSelectEl.addEventListener('change', () => {
            boardTheme = themeSelectEl.value;
            window.CheddarHost.setPreference('chess.boardTheme', boardTheme);
            render();
        });
        container.appendChild(themeSelectEl);

        boardWrapEl = document.createElement('div');
        boardWrapEl.style.display = 'none';
        boardWrapEl.style.gridTemplateColumns = 'repeat(8, 32px)';
        boardWrapEl.style.gridTemplateRows = 'repeat(8, 32px)';
        boardWrapEl.style.border = '1px solid #888';
        boardWrapEl.style.width = 'fit-content';
        boardWrapEl.style.userSelect = 'none';
        boardWrapEl.style.margin = '6px 0';

        // Squares are built once, in a fixed a8..h1 DOM order, and never
        // moved or recreated — orientation (flipped for black) is applied
        // purely via each square's CSS `order`, so a render() only ever
        // updates existing squares' content/highlight/order in place.
        squareEls = {};
        for (let rankIdx = 0; rankIdx < 8; rankIdx++) {
            for (let fileIdx = 0; fileIdx < 8; fileIdx++) {
                const squareName = `${String.fromCharCode(97 + fileIdx)}${8 - rankIdx}`;
                const sq = document.createElement('div');
                sq.style.width = '32px';
                sq.style.height = '32px';
                sq.style.display = 'flex';
                sq.style.alignItems = 'center';
                sq.style.justifyContent = 'center';
                sq.style.fontSize = '22px';
                sq.style.lineHeight = '1';
                sq.style.cursor = 'pointer';
                // Border/fill are set per-render, driven by the chosen
                // board theme — see render()'s per-square loop. "classic"
                // keeps the original outline-only look (no fill, white
                // border) as the default; every other theme fills the
                // square instead, same as the web board.
                sq.style.boxSizing = 'border-box';
                sq.addEventListener('click', () => handleSquareClick(squareName));
                squareEls[squareName] = sq;
                boardWrapEl.appendChild(sq);
            }
        }
        container.appendChild(boardWrapEl);

        const movesHeader = document.createElement('p');
        movesHeader.style.margin = '8px 0 2px';
        movesHeader.style.fontWeight = '600';
        movesHeader.textContent = 'Moves';
        container.appendChild(movesHeader);

        movesListEl = document.createElement('div');
        movesListEl.style.maxHeight = '120px';
        movesListEl.style.overflowY = 'auto';
        movesListEl.style.border = '1px solid #5555';
        movesListEl.style.padding = '4px 6px';
        movesListEl.style.fontFamily = 'monospace';
        movesListEl.style.fontSize = '12px';
        // Without this, a plain div collapses the '\n' between move lines
        // into a single space instead of an actual line break.
        movesListEl.style.whiteSpace = 'pre-line';
        container.appendChild(movesListEl);

        const inputRow = document.createElement('div');
        inputRow.style.display = 'flex';
        inputRow.style.gap = '4px';
        inputRow.style.marginTop = '6px';

        moveInputEl = document.createElement('input');
        moveInputEl.type = 'text';
        moveInputEl.placeholder = 'e.g. Nf3';
        moveInputEl.autocomplete = 'off';
        moveInputEl.spellcheck = false;
        moveInputEl.style.flex = '1';
        moveInputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                submitTypedMove();
            }
        });
        inputRow.appendChild(moveInputEl);

        moveSendBtn = document.createElement('button');
        moveSendBtn.type = 'button';
        moveSendBtn.textContent = 'Send';
        moveSendBtn.addEventListener('click', submitTypedMove);
        inputRow.appendChild(moveSendBtn);
        container.appendChild(inputRow);

        moveErrorEl = document.createElement('p');
        moveErrorEl.style.color = '#e05252';
        moveErrorEl.style.minHeight = '1em';
        container.appendChild(moveErrorEl);

        resignBtnEl = document.createElement('button');
        resignBtnEl.type = 'button';
        resignBtnEl.textContent = 'Resign';
        resignBtnEl.addEventListener('click', () => {
            window.CheddarHost.send('resign', { lobbyId: ctx.lobbyId });
        });
        container.appendChild(resignBtnEl);
    }

    function renderMovesList() {
        const sans = (state && state.moves_san) || [];
        if (!sans.length) {
            movesListEl.textContent = 'no moves yet';
            return;
        }
        // A line break only after black's reply — one full turn per line —
        // not after every single move.
        const lines = [];
        for (let i = 0; i < sans.length; i += 2) {
            const num = i / 2 + 1;
            const white = sans[i] || '';
            const black = sans[i + 1] || '';
            lines.push(`${num}. ${white}${black ? ' ' + black : ''}`);
        }
        movesListEl.textContent = lines.join('\n');
        movesListEl.scrollTop = movesListEl.scrollHeight;
    }

    function render() {
        if (!container || !statusEl) return;

        statusEl.textContent = statusText();

        const color = myColor();
        const flipped = color === 'black';
        const grid = state ? parseFen(state.fen) : null;
        themeSelectEl.value = boardTheme;
        const theme = BOARD_THEMES[boardTheme] || BOARD_THEMES.classic;

        // Last move highlighting: UCI strings are "<from><to>[promotion]",
        // e.g. "e2e4" — same convention the web app's board uses.
        const lastUci = state && state.moves && state.moves.length ? state.moves[state.moves.length - 1] : null;
        const lastFrom = lastUci ? lastUci.slice(0, 2) : null;
        const lastTo = lastUci ? lastUci.slice(2, 4) : null;

        for (const squareName in squareEls) {
            const el = squareEls[squareName];
            const { rankIdx, fileIdx } = squareCoords(squareName);
            const displayRank = flipped ? 7 - rankIdx : rankIdx;
            const displayFile = flipped ? 7 - fileIdx : fileIdx;
            el.style.order = String(displayRank * 8 + displayFile);
            const piece = grid ? grid[rankIdx][fileIdx] : null;
            el.textContent = piece ? PIECE_CHARS[piece] || '' : '';
            // The Unicode chess glyphs (♔ vs ♚) are designed as a single ink
            // color on paper — they have no fill/outline of their own the
            // way a real piece icon would, so without this they only
            // contrast against whichever square color happens to differ
            // enough from the default text color. Both colors use the same
            // 4-direction pixel-offset text-shadow "halo" technique (not
            // -webkit-text-stroke) — it paints solid copies of the glyph
            // just behind the real one, which works on any glyph shape
            // without touching the original's own antialiasing. A stroke
            // was tried first and rejected: on the thinner solid glyphs
            // (the pawn especially) it visibly ate into the glyph's own
            // fill, making it look like a bare vertical line instead of a
            // filled shape — confirmed visually, not just a theory.
            if (piece) {
                const isWhitePiece = piece === piece.toUpperCase();
                el.style.setProperty('-webkit-text-stroke', '0px transparent');
                if (isWhitePiece) {
                    el.style.color = '#f5f5f5';
                    el.style.textShadow = '1px 0 0 #151515, -1px 0 0 #151515, 0 1px 0 #151515, 0 -1px 0 #151515';
                } else {
                    el.style.color = '#151515';
                    el.style.textShadow = '1px 0 0 #e8e8e8, -1px 0 0 #e8e8e8, 0 1px 0 #e8e8e8, 0 -1px 0 #e8e8e8';
                }
            } else {
                el.style.color = '';
                el.style.setProperty('-webkit-text-stroke', '0px transparent');
                el.style.textShadow = 'none';
            }
            el.style.boxShadow = selectedSquare === squareName ? 'inset 0 0 0 2px orange' : 'none';

            const isLastMoveSquare = squareName === lastFrom || squareName === lastTo;
            if (isLastMoveSquare) {
                el.style.backgroundColor = LAST_MOVE_HIGHLIGHT;
                el.style.border = theme.light === null ? '1px solid white' : 'none';
            } else if (theme.light === null) {
                // "classic" — the module's original outline-only look.
                el.style.backgroundColor = 'transparent';
                el.style.border = '1px solid white';
            } else {
                const isLightSquare = (rankIdx + fileIdx) % 2 === 0;
                el.style.backgroundColor = isLightSquare ? theme.light : theme.dark;
                el.style.border = 'none';
            }
        }

        renderMovesList();

        const canAct = !!color && !!state && state.status === 'in_progress';
        moveInputEl.disabled = !canAct || awaitingMove;
        moveSendBtn.disabled = !canAct || awaitingMove;
        moveErrorEl.textContent = errorText;
        resignBtnEl.style.display = canAct ? 'inline-block' : 'none';
    }

    window.CheddarGames = window.CheddarGames || {};
    window.CheddarGames['chess'] = { mount, unmount, onEvent };
})();
