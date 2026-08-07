#!/bin/bash
# Build and push the lookout image to Docker Hub.
# Usage: ./scripts/docker-build-push.sh [version]
set -e

DOCKER_USERNAME="datamaker"
VERSION=${1:-latest}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

echo ">>> Building $DOCKER_USERNAME/lookout:$VERSION (linux/amd64)"
docker build --platform linux/amd64 -t "$DOCKER_USERNAME/lookout:$VERSION" .
if [ "$VERSION" != "latest" ]; then
  docker tag "$DOCKER_USERNAME/lookout:$VERSION" "$DOCKER_USERNAME/lookout:latest"
fi

echo ">>> Pushing"
docker push "$DOCKER_USERNAME/lookout:$VERSION"
if [ "$VERSION" != "latest" ]; then
  docker push "$DOCKER_USERNAME/lookout:latest"
fi

echo ">>> Done: https://hub.docker.com/r/$DOCKER_USERNAME/lookout"
