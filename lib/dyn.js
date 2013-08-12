var _= require('underscore'),
    zlib = require('zlib'),
    async = require('async'),
    AWS = require('aws-sdk');

const _catch= function (fn)
      {
         return function ()
         {
             try
             {
                 fn.apply(null,arguments);
             }
             catch (ex)
             {
                console.log(ex,ex.stack);
             }
         };
      }, 
      _arr= function (val)
      {
          return Array.isArray(val) ? val : [val];
      },
      _value= function (val)
      {
          var type= typeof val;

          if (type=='object'&&val instanceof Buffer)
            return { 'B': val.toString('base64') };
          else
          if (type=='object'&&Array.isArray(val))
          {
              if (val.length>0)
              {
                  var etype= typeof val[0];

                  if (etype=='object'&&val[0] instanceof Buffer)
                    return { 'BS': _.collect(val,function (v) { return v.toString('base64') }) };
                  else
                  if (etype=='number')
                    return { 'NS': _.collect(val,function (v) { return v+''; }) };
                  else
                  if (etype=='string')
                    return { 'SS': _.collect(val,function (v) { return v+''; }) };
                  else
                    throw new Error('unknown type of array value: '+etype);
              }
              else 
                  throw new Error('empty array');
          }
          else
          if (type=='number')
            return { 'N': val+'' };
          else
          if (type=='string')
            return { 'S': val };
          else
          if (type=='boolean')
            return { 'N': (val ? 1 : 0)+'' };
          else
            throw new Error('unknown type of value: '+type);
      },
      _attr= function (o)
      {
          var obj= {};
          
          obj[o.attr]= _value(o.value);

          return obj; 
      },
      _error= function (err)
      {
          return _.extend(new Error(),err);
      },
      _item= function (Item)
      {
           var obj= {};

           Object.keys(Item).forEach(function (key)
           {
              if (Item[key].S !== undefined)
                obj[key]= Item[key].S;
              else
              if (Item[key].N !== undefined)
              {
                 if (Item[key].N.indexOf('.')>-1)
                   obj[key]= parseFloat(Item[key].N);
                 else
                   obj[key]= parseInt(Item[key].N);
              }
              else
              if (Item[key].B !== undefined)
                obj[key]= new Buffer(Item[key].B,'base64');
              else
              if (Item[key].SS !== undefined)
                obj[key]= Item[key].SS;
              else
              if (Item[key].NS !== undefined)
                obj[key]= _.collect(Item[key].NS,function (n)
                {
                     if (n.indexOf('.')>-1)
                       return parseFloat(n);
                     else
                       return parseInt(n);
                });
              else
              if (Item[key].BS !== undefined)
                obj[key]= _.collect(Item[key].BS,function (b) { return new Buffer(b,'base64'); });
           });

           return obj;
      },
      _toItem= function (obj)
      {
           var Item= {};

           Object.keys(obj).forEach(function (key)
           {
                 Item[key]= _value(obj[key]); 
           });

           return Item;
      },
      failedWritesQueue= async.queue(function (f,done)
      {
          setTimeout(function ()
          {
              f();
              done(); 
          },300);
      },1);

failedWritesQueue.saturated= function ()
{
    console.log('failedWritesQueue.saturated');
}

failedWritesQueue.drain= function ()
{
    console.log('failedWritesQueue.drain');
}
/*
 *
 */

module.exports= function (opts)
{
    opts= opts || {};

    AWS.config.update
    ({ 
         accessKeyId: opts.accessKeyId || process.env.AWS_ACCESS_KEY_ID, 
         secretAccessKey: opts.secretAccessKey || process.env.AWS_SECRET_KEY || process.env.AWS_SECRET_ACCESS_KEY,
         region: opts.region || process.env.AWS_REGION
    });

    var _dyn = new AWS.DynamoDB(), 
         dyn = { ctx: {}, queue: { error: [] } },
         _promise= function (success,error)
         {     
               success= success || [];
               error= error || [];
                  
               success= Array.isArray(success) ? success : [success];
               error= Array.isArray(error) ? error : [error];

               var promise= { queue: {}, trigger: {} },
                   _conf= function (also)
                          { 
                              return function (arg)
                              {
                                   promise.queue[arg]= [];

                                   promise[arg]= function (cb)
                                   {
                                       promise.queue[arg].push(cb);
                                       return promise;
                                   };

                                   promise.trigger[arg]= function ()
                                   {
                                        var args= arguments;

                                        promise.queue[arg].forEach(function (cb)
                                        {
                                           cb.apply(null,args);
                                        });

                                        also && also(arg);
                                   };
                              };
                          };

               ['success','error'].forEach(_conf());

               success.forEach(_conf(promise.trigger.success));
               error.forEach(_conf(function (code) { promise.trigger.error(_error({ code: code }),true); }));

               promise.trigger.error= function (err,also)
               {
                    if (!also&&promise.trigger[err.code])
                        promise.trigger[err.code]();
                    else 
                        promise.queue.error.forEach(function (cb)
                        {
                           cb.apply(null,[err]);
                        });
               };

               promise.should= function (what)
               {
                   return function (err)
                   {
                       if (err)
                         promise.trigger.error(err);
                       else
                       {
                           var args= Array.prototype.slice.apply(arguments);
                           args.shift();

                           promise.trigger[what].apply(args);
                       } 
                   };
               };

               return promise;
         };

    dyn.error= function (fn)
    {
        dyn.queue.error.push(fn);
        return dyn;
    };

    dyn.table= function (name)
    {
        dyn.ctx.table= name;
        return dyn;
    };

    dyn.index= function (name)
    {
        dyn.ctx.index= name;
        return dyn;
    };

    dyn.hash= function (attr,value,operator)
    {
        var args= Array.prototype.slice.call(arguments);

        dyn.ctx.hash= { attr: attr, value: value, operator: operator || 'EQ' };

        return dyn;
    };

    dyn.range= function (attr,value,operator)
    {
        dyn.ctx.range= { attr: attr, value: value, operator: operator || 'EQ' };
        return dyn;
    };

    dyn.get= function (cb,opts)
    {
       opts= opts || {};

       var query= { TableName: dyn.ctx.table };

       query.Key= {};

       _.extend(query.Key,_attr(dyn.ctx.hash));

       if (dyn.ctx.range)
         _.extend(query.Key,_attr(dyn.ctx.range));

       if (opts.attrs)
         query.AttributesToGet= opts.attrs;

       if (opts.consistent)
         query= _.extend(query,{ ConsistentRead: true });

       var promise= _promise(null,'notfound');

       console.log('get',dyn.ctx.hash.value);

       process.nextTick(function ()
       {
           _dyn.getItem(query,
           function (err,data)
           {
                  if (err)
                    promise.trigger.error(err);
                  else
                  if (!data.Item)
                    promise.trigger.notfound();
                  else
                    _catch(cb)(_item(data.Item));
           });
       });

       dyn.ctx= {};

       return promise; 
    };

    dyn.query= function (cb,opts)
    {
       opts= opts || {};

       var query= { TableName: dyn.ctx.table };

       query.KeyConditions= {}; 

       query.KeyConditions[dyn.ctx.hash.attr]= { AttributeValueList: _.collect(_arr(dyn.ctx.hash.value),_value),
                                                 ComparisonOperator: dyn.ctx.hash.operator };

       if (dyn.ctx.range)
         query.KeyConditions[dyn.ctx.range.attr]= { AttributeValueList: _.collect(_arr(dyn.ctx.range.value),_value),
                                                    ComparisonOperator: dyn.ctx.range.operator };

       if (dyn.ctx.index)
         query.IndexName= dyn.ctx.index; 

       if (opts.attrs)
         query.AttributesToGet= opts.attrs;

       if (opts.consistent)
         query= _.extend(query,{ ConsistentRead: true });

       if (opts.desc)
         query= _.extend(query,{ ScanIndexForward: false });

       if (opts.limit)
         query= _.extend(query,{ Limit: opts.limit });

       var promise= _promise(null,'notfound');

       console.log('query',dyn.ctx.hash.value);

       process.nextTick(function ()
       {
           _dyn.query(query,
           _catch(function (err,data)
           {
                  if (err)
                    promise.trigger.error(err);
                  else
                  if (data.Items.length==0)
                    promise.trigger.notfound();
                  else
                    cb(_.collect(data.Items,_item));
           }));
       });

       dyn.ctx= {};
 
       return promise; 
    };

    dyn.put= function (obj,cb,opts)
    {
       opts= opts || {};

       var query= { TableName: dyn.ctx.table, Item: _toItem(obj) };

       if (opts.exists)
       {
           query.Expected= {}

           query.Expected[dyn.ctx.hash.attr]= { Exists: true, Value: _value(obj[dyn.ctx.hash.attr]) };

           if (dyn.ctx.range)
             query.Expected[dyn.ctx.range.attr]= { Exists: true, Value: _value(obj[dyn.ctx.range.attr]) };
       }
       else
       if (opts.exists===false)
       {
           query.Expected= {}

           query.Expected[dyn.ctx.hash.attr]= { Exists: false };

           if (dyn.ctx.range)
             query.Expected[dyn.ctx.range.attr]= { Exists: false };
       } 

       var promise= _promise('found','notfound');

       process.nextTick(function putter()
       {
               _dyn.putItem(query,
               function (err,data)
               {
                 if (err)
                 {
                    if (err.code=='ProvisionedThroughputExceededException')
                    {
                        failedWritesQueue.push(putter);   
                        return;
                    }
                    
                    if (err.code=='ConditionalCheckFailedException')
                    {
                        if (opts.exists)
                          promise.trigger.notfound();
                        else
                          promise.trigger.found();
                    }
                    else
                      promise.trigger.error(err);
                 }
                 else
                    _catch(cb)();
               }); 
       });

       dyn.ctx= {};
 
       return promise; 
    };

    dyn.mput= function (ops,cb)
    {
       var query= { RequestItems: {} },
           _operation= function (op)
           {
              var r= {};

              if (op.op=='put')
                r.PutRequest= { Item: _toItem(op.item) };
              else
              if (op.op=='del')
                r.DeleteRequest= { Key: _toItem(op.item) };
              else
                throw new Error('Unknown op type: '+op.op); 

              return r;
           };

       Object.keys(ops).forEach(function (table)
       {
            query.RequestItems[table]= _.collect(ops[table],_operation);
       });

//       console.log(JSON.stringify(query,null,2));

       var promise= _promise();

       process.nextTick(function ()
       {
           _dyn.batchWriteItem(query,
           function (err,data)
           {
                  if (err)
                    promise.trigger.error(err);
                  else
                    _catch(cb)();
           });
       });

       dyn.ctx= {};
 
       return promise; 
    };

    dyn.count= function (cb,opts)
    {
       opts= opts || {};

       var query= { TableName: dyn.ctx.table, Select: 'COUNT' };

       query.KeyConditions= {}; 

       query.KeyConditions[dyn.ctx.hash.attr]= { AttributeValueList: _.collect(_arr(dyn.ctx.hash.value),_value),
                                                 ComparisonOperator: dyn.ctx.hash.operator };

       if (dyn.ctx.range)
         query.KeyConditions[dyn.ctx.range.attr]= { AttributeValueList: _.collect(_arr(dyn.ctx.range.value),_value),
                                                    ComparisonOperator: dyn.ctx.range.operator };

       if (dyn.ctx.index)
         query.IndexName= dyn.ctx.index; 

       if (opts.consistent)
         query= _.extend(query,{ ConsistentRead: true });

       var promise= _promise();

       process.nextTick(function ()
       {
           _dyn.query(query,
           function (err,data)
           {
                  if (err)
                    promise.trigger.error(err);
                  else
                    cb(data.Count);
           });
       });

       dyn.ctx= {};
 
       return promise; 
    };

    dyn.create= function (cb,opts)
    {
       opts= opts || {};
       opts.throughput= opts.throughput || {};

       var query= { 
                    AttributeDefinitions: [],
                    KeySchema: [],
                    ProvisionedThroughput: { ReadCapacityUnits:  opts.throughput.read || 1,
                                             WriteCapacityUnits: opts.throughput.write || 1 },
                    TableName: dyn.ctx.table
                  };

       query.AttributeDefinitions.push({ AttributeName: dyn.ctx.hash.attr,
                                         AttributeType: dyn.ctx.hash.value });

       query.KeySchema.push({ AttributeName: dyn.ctx.hash.attr,
                              KeyType: 'HASH' });

       
       if (dyn.ctx.range)
       {
         query.AttributeDefinitions.push({ AttributeName: dyn.ctx.range.attr,
                                           AttributeType: dyn.ctx.range.value });

         query.KeySchema.push({ AttributeName: dyn.ctx.range.attr,
                                KeyType: 'RANGE' });
       }

       if (opts.secondary&&opts.secondary.length>0)
         query.LocalSecondaryIndexes= _.collect(opts.secondary,
                                      function (idx) 
                                      { 
                                        var _idx= { 
                                                  IndexName: idx.name,
                                                  KeySchema: [_.findWhere(query.KeySchema,{KeyType: 'HASH'}),
                                                              { AttributeName: idx.key.name, KeyType: 'RANGE' }] 
                                               }; 

                                        query.AttributeDefinitions.push({ AttributeName: idx.key.name,
                                                                          AttributeType: idx.key.type });

                                        if (!idx.projection)
                                          _idx.Projection= { ProjectionType: 'ALL' };
                                        else
                                          _idx.Projection= { NonKeyAttributes: idx.projection, ProjectionType: 'INCLUDE' };

                                        return _idx;
                                      });

       var promise= _promise();

       process.nextTick(function ()
       {
           _dyn.createTable(query,
           function (err)
           {
              if (err)
                promise.trigger.error(err);
              else
                _catch(cb)();
           });
       });

       dyn.ctx= {};
 
       return promise; 
    };

    dyn.scan= function (cb,opts)
    {
       opts= opts || {};

       var query= { TableName: dyn.ctx.table },
           _filterField= function (field)
           {
               return { AttributeValueList: _.collect(field.values,_value),
                        ComparisonOperator: field.op };
           },
           _filter= function (filter)
           {
               var r= {};

               Object.keys(filter).forEach(function (field)
               {
                   r[field]= _filterField(filter[field]);
               });

               return r;
           };

       if (opts.attrs)
         query.AttributesToGet= opts.attrs;

       if (opts.limit)
         query= _.extend(query,{ Limit: opts.limit });

       if (opts.filter)
         query= _.extend(query,{ ScanFilter: _filter(opts.filter) });

       var promise= _promise();

       process.nextTick(function ()
       {
           _dyn.scan(query,
           function (err,data)
           {
              if (err)
                promise.trigger.error(err);
              else
                _catch(cb)(_.collect(data.Items,_item));
           });
       });

       dyn.ctx= {};
 
       return promise; 
    };

    dyn.delete= function (cb,opts)
    {
       opts= opts || {};

       var query= { TableName: dyn.ctx.table };

       query.Key= {};

       _.extend(query.Key,_attr(dyn.ctx.hash));

       if (dyn.ctx.range)
         _.extend(query.Key,_attr(dyn.ctx.range));

       if (opts.exists===true)
       {
           query.Expected= {}

           query.Expected[dyn.ctx.hash.attr]= { Exists: true, Value: _value(dyn.ctx.hash.value) };

           if (dyn.ctx.range)
             query.Expected[dyn.ctx.range.attr]= { Exists: true, Value: _value(dyn.ctx.range.value) };
       }

       var promise= _promise(null,'notfound');

       process.nextTick(function deleter()
       {
               _dyn.deleteItem(query,
               function (err)
               {
                 if (err)
                 {
                    if (err.code=='ProvisionedThroughputExceededException')
                    {
                        failedWritesQueue.push(deleter);   
                        return;
                    }
                    
                    if (err.code=='ConditionalCheckFailedException')
                        promise.trigger.notfound();
                    else
                      promise.trigger.error(err);
                 }
                 else
                    _catch(cb)();
               }); 
       });

       dyn.ctx= {};
 
       return promise; 
    };

    dyn.listTables= function (cb)
    {
        _dyn.listTables(function (err,data)
        {
            _catch(cb)(err,err ? null : data.TableNames);
        });
    };

    dyn.describeTable= function (table,cb)
    {
        _dyn.describeTable({ TableName: table },function (err,data)
        {
            _catch(cb)(err,err ? null : data);
        });
    };

    dyn.deleteTable= function (table,cb)
    {
        _dyn.deleteTable({ TableName: table },function (err,data)
        {
            _catch(cb)(err,err ? null : data);
        });
    };

    dyn.promise= _promise;

    return dyn;
}