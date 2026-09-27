# Ship a change

The path from a task on the board to a merged change. The agent does the steps; you own the gate.

## Step 1: Pick the task

Take the highest-priority task in the current sprint that is assigned to you or to `claude`. Move it: `{{CLI}} task update <id> --status "In Progress"`.

## Step 2: Make the change

Work on a branch. Keep the change small enough to review in one sitting. Run the tests.

## Step 3: Write the summary

Add a note to the task with what changed and why: `{{CLI}} task note <id> "..."`. Move it to Review.

## Step 4: SIGN-OFF before pushing

Stop here. The human reads the diff and the summary. Pushing is a red line (`no-push-without-asking`), so the push waits for a yes.

## Step 5: Close the loop

After the merge, move the task to Done and store anything worth remembering with `{{CLI}} remember`.
