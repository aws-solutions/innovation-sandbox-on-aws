FROM public.ecr.aws/amazonlinux/amazonlinux:2023-minimal@sha256:6621917fc09ad8c935aa5ccc32c933c6dec250deafae54af86e154fcd19f5ed0

RUN dnf install -y tar gzip awscli jq sed

ADD https://github.com/ekristen/aws-nuke/releases/download/v3.64.0/aws-nuke-v3.64.0-linux-amd64.tar.gz nuke-binary.tar.gz

RUN mkdir /tmp/aws-nuke && \
    tar -xzvf nuke-binary.tar.gz -C /tmp/aws-nuke && \
    mv /tmp/aws-nuke/aws-nuke /usr/local/bin/aws-nuke && \
    chmod +x /usr/local/bin/aws-nuke && \
    rm -rf /tmp/aws-nuke && \
    rm nuke-binary.tar.gz

ENV PATH=$PATH:/usr/local/bin

USER codebuild-user
