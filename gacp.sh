#!/usr/bin/env bash
# Git add, commit, push, and optionally release @nmzpy/pi-ember-stack.
#
# Usage:
#   ./gacp.sh "commit message"
#   ./gacp.sh --release ["release commit message"]
#
# Every run auto-increments the npm patch version. --release additionally
# tags the commit and publishes to npm.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RELEASE_MODE=0
COMMIT_MSG=""

while (( $# > 0 )); do
	case "$1" in
		--release)
			RELEASE_MODE=1
			shift
			;;
		--message|-m)
			[[ -n "${2:-}" ]] || { echo "ERROR: --message requires a value." >&2; exit 1; }
			COMMIT_MSG="$2"
			shift 2
			;;
		--help|-h)
			cat <<'USAGE'
Usage:
  ./gacp.sh "commit message"
  ./gacp.sh --release ["release commit message"]

Every run auto-increments the npm patch version, typechecks, commits, and pushes.
Release mode additionally tags the commit and publishes @nmzpy/pi-ember-stack to npm.
USAGE
			exit 0
			;;
		-*)
			echo "ERROR: Unknown option: $1" >&2
			exit 1
			;;
		*)
			[[ -z "$COMMIT_MSG" ]] || { echo "ERROR: Unexpected argument: $1" >&2; exit 1; }
			COMMIT_MSG="$1"
			shift
			;;
	esac
done

cd "$SCRIPT_DIR"

command -v npm >/dev/null || { echo "ERROR: npm is required." >&2; exit 1; }

echo "=== Typechecking ==="
npm run typecheck

echo "=== Bumping patch version ==="
VERSION="$(npm version patch --no-git-tag-version)"
VERSION="${VERSION#v}"

if [[ "$RELEASE_MODE" == "1" ]]; then
	npm whoami >/dev/null || {
		echo "ERROR: Log in to npm with 'npm login' before creating a release." >&2
		exit 1
	}
	COMMIT_MSG="${COMMIT_MSG:-release: v$VERSION}"
else
	COMMIT_MSG="${COMMIT_MSG:-chore: v$VERSION}"
fi

echo "=== Staging ==="
git add -A

echo "=== Committing ==="
git commit -m "$COMMIT_MSG"

if [[ "$RELEASE_MODE" == "1" ]]; then
	TAG_NAME="v$VERSION"
	if git rev-parse -q --verify "refs/tags/$TAG_NAME" >/dev/null; then
		echo "ERROR: Tag $TAG_NAME already exists." >&2
		exit 1
	fi
	git tag "$TAG_NAME"
fi

echo "=== Pushing ==="
git push
if [[ "$RELEASE_MODE" == "1" ]]; then
	git push origin "v$VERSION"
	echo "=== Publishing @nmzpy/pi-ember-stack@$VERSION ==="
	npm publish --access public
	echo "=== Release v$VERSION complete ==="
else
	echo "=== Pushed v$VERSION ==="
fi
