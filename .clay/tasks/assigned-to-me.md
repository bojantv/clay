You have been automatically assigned GitHub issue **#{{number}}** in `{{repo}}`.

## Issue
**Title:** {{title}}
**URL:** {{issue_url}}
**Labels:** {{labels}}

{{body}}

---

## How to work this issue

This session was started automatically. Before doing any work, decide whether you
understand the issue well enough to proceed on your own.

1. **Read and understand the issue.** Extract the concrete goal(s): what outcome
   would close this issue? Explore the codebase as needed to ground your understanding.

2. **Rate your confidence (0-100%)** that you BOTH:
   - understand exactly what is being asked, AND
   - know how to implement it correctly without further clarification.

3. **Decide based on the {{confidence_threshold}}% threshold:**

   - **If your confidence is at or above {{confidence_threshold}}%:** Proceed
     autonomously. State the goals you extracted and your plan in one short
     paragraph, then carry out the work end to end: implement the change, verify
     it, and commit/push per the project rules. When everything is fully done,
     end your final message with this marker on its own line:

     ```
     CLAY_TASK_COMPLETE
     ```

   - **If your confidence is below {{confidence_threshold}}%:** Do NOT start
     changing code. Instead, write a short message that (a) summarizes what you
     understood, (b) states your confidence and exactly what is blocking it, and
     (c) lists the specific questions you need answered. Then STOP and wait for a
     reply. End that message with this marker on its own line:

     ```
     CLAY_NEEDS_INPUT
     ```

Only emit one of the two markers, and only the `CLAY_TASK_COMPLETE` marker once
the work is genuinely finished. If you paused for input and later receive answers
that raise your confidence to {{confidence_threshold}}% or above, proceed with the
work as described above.
