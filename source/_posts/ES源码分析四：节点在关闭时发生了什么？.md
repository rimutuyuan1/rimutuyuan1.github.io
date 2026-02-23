---
title: ES源码分析四、节点在关闭时发生了什么？
date: 2021-09-09 08:55:14
tags: Elasticsearch源码分析&实战
---

当ES集群更新配置、升级版本时，需要通过“kill”ES进程来关闭节点。
::ES进程会捕获SIGTERM信号(kill命令默认信号)进行处理，调用各模块的stop方法停止服务并安全退出。::

* 如果主节点被关闭，集群会重新选主，在这个期间集群会进入短暂的无主状态。
* 如果数据节点被关闭，则读写请求的TCP连接也会关闭，对客户端来说写操作执行失败，但写流程已经达到Engine流程的会正常写入，只是客户端无法感知结果。此时客户端重试，如果使用自动生成 ID，则数据内容会重复。

~综合来说，滚动升级产生的影响是中断当前读写请求，以及主节点重启可能引起的分片分配过程。~

## 4.1 关闭流程分析
每个模块的Service中都实现了doStop和doClose方法，用于处理这个模块的正常关闭。
节点总的关闭流程位于Node#close，在close方法的实 现中，先调用一遍各个模块的doStop，然后再次遍历各个模块执行 doClose。

各模块的关闭有一定的顺序，stop方法执行顺序如下：
1. ResourceWatcherService 通用资源监视
2. HttpServerTransport HTTP传输服务（Rest接口服务）
3. SnapshotsService 快照服务
4. SnapshotShardsService  shard快照服务（负责启动和通知shard级快照）
5. IndicesClusterStateService 收集状态信息后处理其中索引相关操作
6. Discovery 集群拓扑管理
7. RoutingService 处理reroute（节点之间迁移shard）
8. ClusterService 集群管理服务（处理集群任务、发布集群状态）
9. NodeConnectionsService 节点连接管理服务
10. MonitorService 提供进程级、系统级、文件系统和JVM的监控服务
11. GatewayService 负责集群元数据持久化与恢复
12. SearchService 处理搜索请求
13. TransportService 底层传输服务
14. plugins  当前的所有插件
15. IndicesService 负责创建、删除索引等操作

综合来看，关闭顺序大致如下:
* 关闭快照和HTTPServer，不再响应用户REST请求。
* 关闭集群拓扑管理，不再响应ping请求。
* 关闭网络模块，让节点离线。
* 执行各个插件的关闭流程。
* 关闭IndicesService。 
最后关闭IndicesService，是因为这期间需要等待释放的资源最多，时间最长。

## 4.2 分片读写过程中执行关闭
### 4.2.1 写入过程中关闭
线程在写入数据时，会对Engine加写锁。
 IndicesService的doStop方法对本节点上全部索引并行执行removeIndex， 当执行到Engine的flushAndClose(先flush然后关闭Engine)，也会对Engine加写锁。由于写入操作已经加了写锁，此时写锁会等待，直到写入执行完毕。因此数据写入过程不会被中断。但是由于网络模块被关闭，客户端的连接会被断开。客户端应当作为失败处理，虽然ES服务端 的写流程还在继续。

### 4.2.2 读取过程中关闭
线程在读取数据时，会对Engine加读锁。 flushAndClose时的写锁会等待读取过程执行完毕。
但是由于连接被关 闭，无法发送给客户端，导致客户端读失败。

节点关闭过程中，IndicesService的doStop对Engine设置了超时，如果flushAndClose一直等待，则CountDownLatch.await默认1天才会继续后面的流程。

## 4.3 主节点被关闭
节点正常执行关闭流程，当TransportService模块被关闭后，集群重新选举新Master。

## 4.4 总结
1. 节点启动流程做初始化和检查工作，各个子模块启动后异步开始工作如: 加载本地数据、选主、加入集群等。
2. 节点在关闭时也有机会处理已经收到的请求，但是写完后或许无法返回客户端，线程池中未执行完的任务在超时时间之内也会继续执行。
3. ::集群健康从Red到Green的时间主要是消耗在维护主副分片的一致性上::。



