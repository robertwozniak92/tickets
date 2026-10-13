# Fixify ticket dispenser

A small interactive page that works like a deli-counter ticket machine, but for IT tickets. It's built from the Figma "Motion" storyboard (Robert's Workshop).

- **Pull** the hanging ticket down. The strip comes out of the slot and leans toward you.
- Keep pulling and it **tears** along the V-shaped perforation. The ticket stays in your hand, the strip snaps back up, and the machine feeds out the next one.
- **Drag** tickets around like paper on a desk. The spot you're holding lifts toward you and the rest trails behind and tilts with momentum. You can also toss them.
- **Pick a paper color** in the top-right corner (or at the bottom on phones). It recolors the tickets still in the machine, and tickets you've already torn off keep their color. The custom swatch opens a full color picker, and your choice is remembered.
- **Tap** a ticket to start working on it (it gets a stamp with a running timer). Tap it again to mark it fixed. After a second it flies onto the done pile in the bottom-right corner.

There are no dependencies and no build step. Open `index.html` directly, or serve the folder:

```sh
python3 -m http.server 8000   # then visit http://localhost:8000
```

## Files

- `index.html`: the page shell
- `styles.css`: ticket artwork (in Figma design units), the slot, and the HUD
- `app.js`: ticket geometry, strip and tear physics, rigid-body dragging with 3D tilt, ticket status

## Notes

- The design uses **PP Neue Montreal**. It's used if installed locally; otherwise the page falls back to Inter Tight from Google Fonts.
- Tuning constants (tear distance, spring stiffness, lift height, tilt limits) are at the top of `app.js`.

## Hosting

Every push to `main` deploys the site to GitHub Pages through `.github/workflows/pages.yml`. To set it up the first time, open **Settings → Pages** and set **Source** to **GitHub Actions**. Free accounts can only use Pages on public repos.
