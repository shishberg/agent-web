<script setup lang="ts">
defineProps<{
  role: "user" | "assistant" | "system";
  streaming?: boolean;
}>();
</script>

<template>
  <article class="message" :class="[`message-${role}`, { streaming }]">
    <div class="message-role">{{ role }}</div>
    <div class="message-body">
      <slot />
    </div>
  </article>
</template>
