// Web app (Next.js BFF).

resource "vercel_project" "web" {
  name      = local.name
  framework = "nextjs"

  // The Next.js app is not at the repo root.
  root_directory = "apps/web"

  git_repository = {
    type = "github"
    repo = var.github_repo
  }

  // pnpm workspaces: install from the repo root so workspace packages resolve,
  // then let Vercel build only the web app.
  install_command = "pnpm install --frozen-lockfile"
}
