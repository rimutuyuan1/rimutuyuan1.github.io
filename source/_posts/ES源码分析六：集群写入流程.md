---
title: ES源码分析六、集群写入流程
date: 2021-10-06 04:41:11
tags: Elasticsearch源码分析&实战
---

在ES中，单个写入文档的请求被称为Index请求；批量写入文档的请求被称为Bulk请求。
写入单个或者多个文档的请求都被封装为BulkRequest请求。

##  几种文档操作的定义
```
enum OpType {
INDEX(0)， CREATE(1)， UPDATE(2)， DELETE(3);
}
```

INDEX : 向索引中PUT一个文档的操作被称为“索引“一个文档。 
CREATE : PUT请求中如果携带参数 op_type:create ，如果主键在索引中已存在，那么索引失败。
UPDATE : 默认向索引中PUT一个文档，如果该文档已存在，那么更新它。
DELETE :  删除文档

## OP_TYPE可选参数
写入文档时，可以通过op_type来指定操作类型。
1. Version ： 指定文档版本号，主要用于实现乐观锁
::乐观锁:::
2. version_type : 控制版本号的比较，在文档并发更新时同步数据
::默认为internal，参数指定的版本号与文档中版本号相同则写入::
::external:当前索引中该文档对应版本号小于请求参数中的版本号则写入::
3. op_type :  文档写入时的操作类型
::可设置为true，如果索引中主键不存在则写入，若存在则写入失败::
4. routing : 指定路由规则
::默认按照索引主键路由，指定routing后按照routing路由::
5. wait_for_active_shards : 用于控制写一致性，当指定数量的分片副本可用时执行写入，否则写入失败，默认为1，主分片可用时即可写入。
6. refresh : 写入完毕后立即执行refresh操作，使搜索可见。
7. timeout : 请求超时时间，默认1min。
8. Pipeline :  指定事先创建好的pipeline名称。

## 1.1 Index/Bulk基本流程
新建、索引、删除都是写操作，必须在主分片执行成功后才复制到副本分片。

### 1.1.1 单个文档写入步骤
1. 客户端向Node1发送写入请求，此时Node1被称为协调节点。
2. Node1拿到文档的主键后经过路由规则（默认取模？）确定文档属于分片0，通过集群状态中
的内容路由表信息获知分片0的主分片位于NODE3，因此请求被转发到 NODE3上。
3. NODE3上的主分片执行写操作。如果写入成功，则它将请求 并行转发到 NODE1和NODE2的副分片上，等待返回结果。当所有的副 分片都报告成功，NODE3将向协调节点报告成功，协调节点再向客户端报告成功。

在客户端收到写入成功的消息回应后，主分片和副本分片都已经写入成功。

> 写一致性的默认策略是quorum，即多数的分片(其中分片副本可以是主分片或副分片)在写入操作时处于可用状态。  
quorum = int( (primary + number_of_replicas) / 2 ) + 1

### 1.1.2 文档写入详细流程
![](ES%E6%BA%90%E7%A0%81%E5%88%86%E6%9E%90%E5%85%AD%EF%BC%9A%E9%9B%86%E7%BE%A4%E5%86%99%E5%85%A5%E6%B5%81%E7%A8%8B/5EEFB82B-7A1D-4C5D-9CB9-64F6A4BED484.png)

#### 1.1.2.1  协调节点写入流程
协调节点负责创建索引、转发请求到主分片节点、等待响应、回复客户端。
~实现位于TransportBulkAction。执行本流程的线程池: http_server_worker。~

* 参数检查：对index/type/source/contextType/opType/version/id 等进行检查，如果检查失败直接返回错误。
* pipeline请求处理：请求预处理，如果Index或Bulk请求中指定了pipeline参数，则先使用相应的 pipeline进行处理。如果本节点不具备预处理资格，则将请求随机转发 到其他具备预处理资格的节点。
* 自动创建索引：如果配置为自动创建索引，并且当前请求写入的索引不存在，则创建索引，如果索引创建失败，则该请求失败。索引创建成功后将新的集群状态发布完毕（Master发布clusterState的Request收到半数以上的节点Response，认为发布成功）再返回成功。
* 对请求的预先处理：不同于请求预处理，对请求的预先处理只是检查参数、自动生成id、处理routing等。
~由于上一步可能有创建索引操作，所以在此先获取最新集群状态信 息。然后遍历所有请求，从集群状态中获取对应索引的元信息，检查 mapping、routing、id等信息。如果id不存在，则生成一个UUID作为文 档id。~
* 检测集群状态：协调节点在开始处理时会先检测集群状态，若集群异常则取消写入。
~Master节点不存在，会阻塞等待Master节点直至超时~
~索引为Red时，如果Master节点存在，则数据可以写到正常 shard,Master节点不存在，协调节点会阻塞等待或取消写入。~
* 内容路由：构建基于shard的请求（本质是拆分&合并请求的过程）。如果索引10个文档的Bulk请求中有5个文档被路由到分片A，另外5个文档被路由到分片B，那么ES会将前5个文档的请求合并到一起，另外5个文档的请求合并到一起，分别请求不同的分片写入。
* 路由算法：根据routing和文档id计算目标shardid的过程。
> 计算公式：shard_num = hash(_routing) % num_primary_shards   _routing值一般为文档主键  
~ES使用随机id和Hash算法来确保文档均匀地分配给分片。当使用自定义id或routing时， id 或 routing 值可能不够随机，造成数据倾斜，部分分片过大。~
* 转发请求并等待响应：根据集群状态中的内容路由表确定主分片所在节点，转发请求并等待响应。
~遍历所有需要写的 shard，将位于某个 shard 的请求封装为BulkShardRequest 类，调用TransportShardBulkAction#execute执行发送， 在listener中等待响应，每个响应也是以shard为单位的。如果某个shard 的响应中部分doc写失败了，则将异常信息填充到Response中，整体请 求做成功处理。~

#### 1.1.2.2 主分片写入流程
执行本流程的线程池:bulk
~主分片所在节点负责在本地写主分片，写成功后，转发写副本片请求，等待响应，回复协调节点。~

* 检查请求：主要检测当前请求是否是写的主分片；写入的索引是否处于关闭状态等
* 是否延迟执行：如果为延迟执行，则放在delay队列中
* 判断主分片是否发生迁移：如迁移，则将请求转发到迁移后的节点
* 检测写一致性：写入之前需要判断写入的分片活跃数是否足够，不足则取消写入，默认为1，主分片可用即可写入。
* 写Lucene和事务日志：遍历请求，处理动态字段映射，通过InternalEngine#index进行逐条写入，索引过程中先写Lucene，再写translog，保证如果Lucene写入失败后避免translog回滚问题。
~写入Lucene之前，先生成Sequence Number和Version。这些都是 在InternalEngine类中实现的。Sequence Number每次递增1,Version根据 当前doc的最大版本加1。~
*  flush translog：根据配置的translog flush策略进行刷盘控制，定时或立即刷盘
* 写副本分片：遍历主分片的副本，依次异步写入
~在等待Response的过程中，本节点发出了多少个Request，就要等待 多少个Response。无论这些Response是成功的还是失败的，直到超时。收集到全部的Response后，执行finish()。给协调节点返回消息， 告知其哪些成功、哪些失败了。~
* 处理副本分片写失败情况：主分片所在节点将发送一个shardFailed请求给Master，然后Master会更新集群状态，在新的集群状态中，这个shard将从in_sync_allocations列表中删除；在routing_table的shard列表中将state由STARTED更改为UNASSIGNED；添加到routingNodes的unassignedShards列表。

#### 1.1.2.3 副本分片写入流程
执行本流程的线程池:bulk
执行流程与主分片基本相同，

## 1.2 IO异常处理
在一个shard上执行的一些操作可能会产生I/O异常之类的情况。
一 个shard上的CRUD等操作在ES里由一个Engine对象封装，在Engine处理过程中，部分操作产生的部分异常ES会认为有必要关闭此Engine，上报 Master。

对Engine异常的捕获目前主要通过IOException实现。
```
 try {
 		indexIntoLucene(index, plan); //索引文档到Lucene
 } catch (RuntimeException | IoException e) {
      try {
			maybeFailEngine();
		} catch (Exception e) {
			e.printStackPrice();
		}
 }
```

Engine类中的maybeFailEngine()负责检查是否应当关闭引擎 failEngine()。

可能会触发maybeFailEngine的操作有：
* CreateSearcherManager  IOException  创建搜索管理器
* index    IOException、RuntimeException  索引文档
* delete    IOException、RuntimeException  删除文档
* sync flush    IOException   同步刷新
* sync commit    IOException  同步提交
* flush    FlushFailedEngineException  刷盘
* force merge     Exception 手动合并Lucene分段

## 1.3 系统特性
* 数据可靠性：通过分片副本和事务日志机制保障数据安全。
* 服务可用性：在可用性和一致性的取舍方面，默认情况下 ES 更 倾向于可用性，只要主分片可用即可执行写入操作。
* 一致性：弱一致性。只要主分片写成功，数据就可能 被读取。因此读取操作在主分片和副分片上可能会得到不同结果。
* 原子性：索引的读写、别名更新是原子操作，不会出现中间状 态。但bulk不是原子操作，不能用来实现事务。
* 扩展性：主副分片都可以承担读请求，分担系统负载。







