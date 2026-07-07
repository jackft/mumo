# mumo
tools for doing multimodal interaction research

## Install
Download an installer or binary from [releases](https://github.com/jackft/mumo/releases). Runs on Linux Mac Windows.

## Builds

The browser app build is relocatable by default. You can copy `packages/mumo/dist/`
under a subpath such as `static/app/` and serve it from `/app/` without rebuilding
for that exact path:

```sh
pnpm run build:web
rsync -av --delete packages/mumo/dist/ /path/to/site/static/app/
```

If you want the generated HTML to contain absolute `/app/` asset URLs instead,
set `MUMO_BASE_PATH`:

```sh
MUMO_BASE_PATH=/app/ pnpm run build:web
```

The embeddable library build writes to `packages/mumo/dist-lib/`:

```sh
pnpm run build:lib
cp -r packages/mumo/dist-lib/. /path/to/site/static/app/
```
