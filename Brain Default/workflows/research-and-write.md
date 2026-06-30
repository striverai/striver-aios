---
type: workflow
name: Research → Write
slug: research-and-write
status: active
description: Nghiên cứu chủ đề rồi viết bài hoàn chỉnh.
steps:
- agent: researcher
  task: 'Nghiên cứu kỹ chủ đề: {{input}}. Tìm nguồn, tổng hợp insight chính.'
- agent: writer
  task: 'Viết một bài hoàn chỉnh về ''{{input}}'' dựa trên nghiên cứu sau:

    {{prev}}'
updated: '2026-06-28'
---

Nghiên cứu chủ đề rồi viết bài hoàn chỉnh.
