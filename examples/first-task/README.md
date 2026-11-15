# Practice a first task

This dependency-free example starts with a failing test: `clamp` does not enforce
the lower bound.

Copy this directory to a disposable location and create a Git repository using
your own configured Git identity:

```sh
practice_dir=$(mktemp -d)
cp -R examples/first-task/. "$practice_dir/"
cd "$practice_dir"
git init
git add .
git commit -m "Add practice task"
```

Choose an existing trusted-host OpenCode route profile and replace `ROUTE` with
its name. Initialize the preset and preview the task:

```sh
ox-driver init --route ROUTE --owned src --check 'node --test'
ox-driver work "Fix clamp so it respects both inclusive bounds and passes the existing test" --dry-run
```

Run the task after the preview reports the route ready:

```sh
ox-driver work "Fix clamp so it respects both inclusive bounds and passes the existing test"
```

The result displays an orchestration ID, the checks, changed paths, and the
managed workspace. Inspect the result and export its verified patch, replacing
`ORCHESTRATION_ID` with the displayed ID:

```sh
ox-driver result ORCHESTRATION_ID
ox-driver patch ORCHESTRATION_ID --out work.patch
cat work.patch
```

Review the patch before applying it to the original repository. Apply it only
if you want the change, then rerun the test:

```sh
git apply --check work.patch
git apply work.patch
node --test
```
