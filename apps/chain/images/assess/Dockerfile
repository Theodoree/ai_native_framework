FROM alpine:3.20

# 需求评估节点：不接模型，只做「这段正文能不能被评估」的机械判断。
# 它证明两件事：容器能读到平台注入的东西，容器能在输出里给出自审结论。
RUN adduser -D -u 10001 chain
COPY assess.sh /usr/local/bin/assess
# 脚本要能被解释器读：只给 x 不给 r 会报 Permission denied（COPY 保留源文件权限 0600）
RUN chmod 755 /usr/local/bin/assess
USER chain
WORKDIR /work
# 执行器每次都会自己给 command（模板表里必填），所以这里只留 CMD 作默认值，
# 不能只写 ENTRYPOINT——那样追加的 command 会变成脚本的参数。
CMD ["/usr/local/bin/assess"]
