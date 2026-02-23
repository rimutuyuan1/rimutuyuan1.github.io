# Notion 接入说明（Hexo）

## 目标
- 在 Notion 数据库写文章
- 自动同步到 `source/_posts`
- 推送后由 GitHub Pages 自动发布

## 1. Notion 数据库字段
建议字段名（可改）：
- `Title` (Title)
- `Date` (Date，可选)
- `Tags` (Multi-select，可选)
- `Published` (Checkbox，发布开关)

## 2. 配置 GitHub Secrets
仓库 Settings -> Secrets and variables -> Actions:
- `NOTION_TOKEN`
- `NOTION_DATABASE_ID`

可选（如果字段名不是上面默认）：
- `NOTION_PROP_TITLE`
- `NOTION_PROP_DATE`
- `NOTION_PROP_TAGS`
- `NOTION_PROP_PUBLISHED`

## 3. 工作流
- `Sync Notion Diary`
  - 每天 UTC 00:00 自动同步
  - 也可手动触发
- `Deploy Hexo to Pages`
  - `main/master` 有变更即自动构建并发布

## 4. 本地调试
```bash
cp .env.example .env
# 填入 token 与 database id
npm ci
npm run sync:notion
npx hexo clean && npx hexo generate
```

## 4.1 一键同步并推送
写完 Notion 后可直接运行：
```bash
npm run publish:notion
```
这个命令会自动执行：
- 拉取远端最新代码（rebase）
- 从 Notion 同步到 `source/_posts`
- 有变更就提交并推送到当前分支
- 推送后由 GitHub Actions 自动部署 Pages

## 5. GitHub Pages 设置
仓库 Settings -> Pages -> Build and deployment:
- Source: `GitHub Actions`

## 6. 说明
- 同步脚本只处理 `Published=true` 的页面。
- 输出文件名格式：`YYYY-MM-DD-slug.md`。
- 内容将写入 `source/_posts`，不会改动你已有文章。
