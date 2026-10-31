# NewfieCad

A browser-based parametric CAD app for designing 3D-printable parts, with Fusion 360-style controls.
It uses the OpenCascade geometry kernel (through [replicad](https://replicad.xyz)) for real solids, fillets and shells.
It exports STL and 3MF for your slicer.

**Try it in your browser:** <https://phuzzyday.github.io/NewfieCad/> (nothing to install; a Chrome-based browser works best).
Or download it and run it on your own computer, offline, as described below.

**Install it as an app:** in Chrome or Edge, open the link above and click **Install app** in NewfieCad's top bar (or the
install icon in the address bar). It then has its own icon and window, works offline, and updates itself when the
site changes. Installed, it can also open `.stl` files and saved projects (`.json`) straight from your file manager:
right-click one and choose Open with, then NewfieCad. This works on Windows and Linux; Firefox can use the site but
can't install it.

## Running it

You need Python 3 (no other installs). No internet connection is needed: the libraries are in the `lib` folder.
If `lib` is missing or incomplete, run `python fetch_libs.py` once (with internet) to download them (about 26 MB).

- **Windows:** double-click `start.bat`
- **Linux / macOS:** run `sh start.sh` in this folder

Either one serves the folder at <http://127.0.0.1:8765/> and opens your browser.
Use a different port with `start.bat 9000` or `sh start.sh 9000`. Press Ctrl+C in the window to stop.

## Mouse controls

| Action | Mouse |
|---|---|
| Pan | Middle-drag |
| Orbit | Shift + middle-drag (orbits around the point under the cursor) |
| Zoom | Wheel (zooms toward the cursor) |
| Laptop / no middle button | Right-drag orbits, Shift + right-drag pans |
| Standard views | Click a face, edge or corner of the view cube |
| Home / Fit | Buttons under the view cube, or F6 to fit |
| Visual style | Drop-down under the view cube: Shaded, Shaded with visible edges, Shaded with hidden edges (dashed), Wireframe, Wireframe with visible edges only, or See-through |

## Selecting

| Action | Mouse |
|---|---|
| Select a face or edge | Click it (hovering shows what you'll get) |
| Select a whole body | Middle-click any face of it (a middle drag still pans), double-click it, or click its name in the tree |
| Add or remove | Ctrl + click (also Ctrl + middle-click, Ctrl + double-click, and Ctrl in the tree) |
| Box select | Drag on the view. Left to right (solid box) takes only what's fully inside; right to left (dashed green box) takes anything it touches |
| Clear | Click empty space, or Esc |

Outside a command, a box selects bodies. Inside a command it picks what that command needs: edges in Fillet and Chamfer, faces in Shell, bodies in Move and Pattern.

When there is only one visible body, Move/Copy, Scale, Shell (Hollow), Pattern and Mirror (Bodies) start with it picked.
What you select carries into the next command. For example, select two edges and press F to fillet them,
double-click two bodies and press M to move them, or select a flat face and click Create Sketch to sketch on it.

## Workflow

1. **Create Sketch**: click an origin plane or any flat face, including slanted ones.
2. Draw with Line, Rectangle, Center Rectangle, Circle, 3-Point Arc, Polygon (sides set in the panel) or Slot
   (click both end centres, then the width).
   While drawing, type a number to enter an exact size (Tab moves between width and height, Enter applies).
   Ends that touch share one point. Drawing adds constraints for you: snapping to a point joins it, a nearly flat
   line becomes Horizontal or Vertical, a point snapped onto a curve stays on it, and a point on the origin is fixed.
   Typed sizes become dimensions.
   **Constrain**: with **Select**, click geometry (Shift or Ctrl adds), then a button in the CONSTRAIN group:
   Coincident, Horizontal, Vertical, Parallel, Perpendicular, Tangent, Equal, Concentric, Midpoint or Fix.
   Small icons show each constraint; click one and press Delete to remove it.
   **Dimension** (D): click a line (then empty space) for its length, a circle or arc for its size, two points
   for their distance, a point and a line, or two lines for their angle. Type the value and press Enter.
   Double-click a dimension later to change it, and the sketch reshapes.
   Drag points and curves with Select; constraints hold while you drag. Black geometry is fully fixed, blue can
   still move, and the panel shows how many degrees of freedom are left.
   **Construction** (X) turns selected curves into dashed helper lines that don't make profiles.
   **Fillet** rounds a clicked corner where two lines meet (radius in the panel). **Trim** (T) cuts away the clicked
   piece of a curve up to where others cross it. **Offset** (O) copies the selected chain of curves, or a circle,
   outward by the distance in the panel (a negative distance goes inward). **Project** (P) brings clicked body
   edges into the sketch as fixed lines, arcs and circles.
3. **Finish Sketch**, then **Extrude** or **Revolve** the closed profiles. Click profiles to choose which ones.
   Extrude has an arrow on the profile: drag it to set the distance (1 mm steps, Shift for 0.1 mm), or type it in the panel.
4. Add **Fillet**, **Chamfer** (click edges), **Shell** or **Hole** (click a flat face).
   Shell: click faces to remove for an open shell, or pick none to hollow the body sealed.
   With several bodies, set Type to **Hollow (sealed)** and click the body. A sealed hollow traps resin on resin printers; add a drain hole.
5. Or skip the sketch: **Primitives ▾** opens a row of buttons under the toolbar for Box, Cylinder, Sphere, Torus and Cone.
   The row stays open until you click the same ▾ button again, press ×, or open another ▾ row (Pattern ▾ has one too).
   Draw it like in Fusion: click an origin plane (snaps to whole millimetres) or a flat face, move the mouse and click to set the size,
   then move and click to set the height. For a Box the first click is a corner; for the round shapes it is the centre.
   While moving, type a number to enter it exactly (Tab between Width and Depth, Enter applies). Sizes snap to 1 mm; Shift gives 0.1 mm.
   Afterwards, drag the arrows on the shape or change the numbers in the panel.
   While you drag, a blue outline follows the mouse at once; the shaded result catches up a moment later.
   Where the origin planes overlap on screen, a click goes to the one you are looking at most squarely (the lit-up one).
   Box, Cylinder and Cone stand on the plane and grow along its normal. A Cut goes into the part, and **Flip direction** reverses it.
   Sphere and Torus are centred on the point. Choose New Body, Join or Cut, as with Extrude.
   A primitive placed on a face stays on that face if an earlier change moves it.
6. **Press Pull** (Q): click a flat face, then drag its arrow or type a distance.
   Pulling out adds material to that body, pushing in removes it. A face with holes in it keeps the holes.
7. **Move/Copy** (M): click bodies, then drag the arrows to move along X/Y/Z or the rings to rotate.
   Drags snap to 1 mm and 5°; hold Shift for 0.1 mm and 1°. You can also type the values.
   The rotation turns about the centre of the selected bodies. Tick **Keep original** to make a copy.
   **Combine** (MODIFY) joins, cuts or intersects bodies: click the target body (blue), then the tool bodies (orange).
   Join merges the tools into the target, Cut removes their shape from it, and Intersect keeps only the overlap.
   The tools are used up unless you tick **Keep tool bodies**. Bodies selected beforehand: the first is the target, the rest are tools.
   **Scale** (MODIFY) resizes bodies by one factor in every direction, about their centre or the origin.
   **Remove** deletes bodies: select whole bodies and press **Delete**, right-click a body in the tree and choose Remove,
   or use the Remove button. It adds a step to the timeline; delete or edit that step to bring the body back.
8. **Pattern ▾** (Rectangular or Circular) and **Mirror** repeat either whole **bodies** (click them) or earlier **features** (tick them in the panel).
   Features are extrudes, revolves, holes and primitives, for example one hole repeated into a grid of screw holes.
   Copies of bodies become new bodies. Repeated features cut or join where the originals did, and follow later edits to them.
   A circular pattern's count includes the original. With 360° the copies are spread evenly.
   In any of these steps, clicking empty space (not on a body) does the same as OK, once the preview is valid.
9. **Insert STL** (CREATE) brings in an STL file as a solid you can cut, join, Press Pull, move, scale and pattern.
   Set the file's units (mm, cm or inches) and a scale per axis. By default it is centred on the origin and stands on the XY plane.
   Flat areas made of many triangles become single faces, so boxy parts get real faces and edges.
   STLs over 15,000 triangles are first simplified (you choose the count), because cuts on denser meshes get very slow.
   Simplifying keeps the overall shape but coarsens fine detail and curves.
10. Every step is in the **timeline** at the bottom. Double-click one to change it, and the model rebuilds.
   Right-click a step to rename, suppress or delete it.

Number fields accept arithmetic, for example `40/2 + 3`.

### Keyboard

| Key | Action |
|---|---|
| E / F / H / M / Q | Extrude / Fillet / Hole / Move / Press Pull |
| L / R / C / A / S / D / X | Sketch: Line / Rectangle / Circle / Arc / Select / Dimension / Construction |
| T / O / P | Sketch: Trim / Offset / Project |
| Esc | End the line chain, cancel the dialog, or clear the selection |
| Enter | OK in a dialog |
| Ctrl+Z / Ctrl+Y (or Ctrl+Shift+Z) | Undo / Redo, also inside a sketch |
| Ctrl+S | Save project |
| F6 | Fit view |

## Files

- **Save** downloads a `.newfiecad.json` project file. **Open…** loads one (older `.printcad.json` files open too).
- Your current design is also auto-saved in the browser and restored when you reopen the page.
- Imported STLs are stored inside the project file, so a project opens complete on another computer.
- **Export STL / Export 3MF** exports at a finer mesh quality than the screen uses, and asks for the file name each time.
  In Chrome and Edge this is a real Save As window where you also pick the folder; other browsers save to Downloads.
  - With bodies selected, it exports those. With nothing selected and one body, it exports that one.
  - Otherwise a panel lists the bodies. STL holds one body per file, so each body has its own **Save STL…** button.
    3MF has tick boxes and puts the ticked bodies in one file as separate objects.
  - Right-click a body in the tree to export just that body.

## Known limits of this first version

- Sketch constraints are solved by planegcs, FreeCAD's solver (LGPL 2.1).
- Profiles come from closed chains of lines and arcs, plus rectangles and circles. Where curves cross, each enclosed area is its own profile.
- Fillets, chamfers and shells find their edges and faces by position. If an earlier change moves an edge a lot, the nearest edge is used and the timeline marks that step yellow.
- Imported STL bodies are made of many small faces. Fillet, Chamfer and Shell rarely work on them, and edits to a
  15,000-triangle body take a few seconds to rebuild. Edge lines aren't drawn on very dense bodies.
- Scale is uniform. Per-axis scale is only available when inserting an STL.
- Press Pull works on flat faces only, and moves the face straight along its normal. Sliding or tilting a face isn't supported.
- Patterning or mirroring features uses their original positions. Features you pattern after a Move don't follow the move; pattern the bodies instead.
- Some combinations can't be built by the kernel, for example shelling a part after cutting a blind hole. Doing the Shell before the Hole works. Failed steps turn red in the timeline.

## Project layout

```
index.html          page layout
css/app.css         styling
js/main.js          app controller, undo/redo, toolbar, files
js/viewport.js      3D view, camera controls, picking
js/viewcube.js      view cube
js/sketch.js        sketch mode and tools
js/sketch-model.js  sketch points, curves and constraints
js/solver.js        constraint solving (planegcs)
js/sketch-tools.js  polygon, slot, fillet, trim, offset, project
js/geom2d.js        2D curve crossings, shared by trim and profiles
js/sketch-labels.js dimension values and constraint icons on screen
js/profiles.js      2D profile detection (shared with the kernel)
js/features.js      feature dialogs and the measure tool
js/gizmo.js         move arrows and rotate rings
js/shape-drag.js    drawing primitives by dragging, and resize arrows
js/outline.js       instant outlines shown while dragging
js/select.js        selecting outside commands (click, Ctrl, box)
js/stl.js           STL reading and the mesh format stored in projects
js/simplify.js      mesh simplification (run by js/simplify-worker.js)
js/kernel.js        talks to the kernel worker
js/kernel-worker.js replicad / OpenCascade feature rebuild
js/timeline.js, js/tree.js, js/io.js, js/ui.js, js/icons.js
serve.py            local web server (no caching, so edits show up on reload)
manifest.webmanifest, sw.js, icon*  installable-app description, offline support, app icons
fetch_libs.py       downloads the libraries into lib/ (already done; rerun to restore or update them)
lib/                three.js (MIT), replicad (MIT), OpenCascade for replicad (LGPL 2.1) and planegcs (LGPL 2.1),
                    each with its licence file. Keep these licence files when you pass the app on.
```

## Licence

NewfieCad is released under the MIT licence (see LICENSE), copyright (c) 2026 Phil Davis.
The libraries in `lib` keep their own licences: three.js and replicad are MIT; the OpenCascade build and planegcs are LGPL 2.1.
Their licence files are in their folders; keep them when you pass the app on.
