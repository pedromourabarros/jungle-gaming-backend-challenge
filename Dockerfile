FROM oven/bun:1.3.3 AS development
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run typecheck && bun run build
CMD ["bun", "src/main.ts"]

FROM oven/bun:1.3.3 AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY --from=development /app/dist ./dist
COPY --from=development /app/src ./src
COPY --from=development /app/scripts ./scripts
COPY --from=development /app/tsconfig.json ./tsconfig.json
USER bun
EXPOSE 3000
CMD ["bun", "dist/main.js"]
