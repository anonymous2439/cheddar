// Cheddar game module contract:
//
//   window.CheddarGames['<game_key>'] = {
//     mount(container, ctx),   // called once when the game starts
//     unmount(container),      // called when the lobby/game view goes away
//   }
//
// `container` is a DOM element the host (chat.js) hands you — do whatever
// you want inside it. `ctx` is read-only context from the host:
//   { gameKey, gameName, lobbyId, selfId, participants: [{id, username, display_name}] }
//
// The module never talks to the Cheddar API directly — the host already
// resolved who's in the lobby and hands that down via ctx. That's enough for
// a game this simple; a heavier game could still make its own authenticated
// calls if it needed to, using the same access token pattern as the host.
(function () {
    function mount(container, ctx) {
        container.innerHTML = '';

        const me = ctx.participants.find((p) => p.id === ctx.selfId);
        const others = ctx.participants.filter((p) => p.id !== ctx.selfId);

        const heading = document.createElement('p');
        heading.textContent = `Hello, ${me ? me.display_name : 'World'}! 👋`;
        container.appendChild(heading);

        const sub = document.createElement('p');
        sub.textContent = others.length
            ? `Playing "${ctx.gameName}" with ${others.map((p) => p.display_name).join(', ')}.`
            : `Playing "${ctx.gameName}" solo.`;
        container.appendChild(sub);

        const note = document.createElement('p');
        note.textContent = 'This is the whole game — it just proves a vendored module can render.';
        container.appendChild(note);
    }

    function unmount(container) {
        container.innerHTML = '';
    }

    window.CheddarGames = window.CheddarGames || {};
    window.CheddarGames['hello_world'] = { mount, unmount };
})();
