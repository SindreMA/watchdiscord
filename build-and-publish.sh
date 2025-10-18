#!/bin/bash

set -e

# Configuration
IMAGE_NAME="watchdiscord"
REGISTRY="registry.k8s.sindrema.com/images"
TAG="latest"
FULL_IMAGE="${REGISTRY}/${IMAGE_NAME}:${TAG}"

echo "Building Docker image: ${FULL_IMAGE}"
docker build -t ${FULL_IMAGE} .

echo "Pushing image to registry..."
docker push ${FULL_IMAGE}

echo "Build and publish completed successfully!"
echo "Image: ${FULL_IMAGE}"
