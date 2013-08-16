var dyno= require('./lib/dyn.js'),
    diff = require('deep-diff').diff,
    uuid= require('node-uuid').v4,
    _= require('underscore'),
    async= require('async'); 

var _parser= require('./lib/parser'), 
    _finder= require('./lib/finder'),
    _refiner= require('./lib/refiner'),
    _index= require('./lib/indexer');

const _traverse= function (o, fn)
      {
         Object.keys(o).forEach(function (i)
         {
             fn.apply(null,[i,o[i],o]);
             if (typeof (o[i])=='object')
               _traverse(o[i],fn);
         });
      },
      _deepclone= function (obj)
      {
         return JSON.parse(JSON.stringify(obj));
      };

module.exports= function (opts,cb)
{
   
   if (!cb)
   {
     cb= opts;
     opts= {};
   }

   opts= opts || {};

   var dyn= dyno(opts.dynamo),
       finder= _finder(dyn),
       parser= _parser(dyn),
       db= {};

   db.cleanup= function (obj)
   {
      var clone= _deepclone(obj);
      _traverse(clone, function (key, value, clone)
      {
         if (key.indexOf('$')==0&&key!='$id')
           delete clone[key]; 
      });

      return clone;
   };


   var configureTable= function (table)
       {
            table.find= function (cond,projection)
            {
                var p, modifiers= {};

                p= dyn.promise('results','notfound');

                process.nextTick(function ()
                {
       //            buildQuery.apply(modifiers,args);

                   parser
                   .parse(table,modifiers,cond,projection)
                   .parsed(function (query)
                   {
                       refiner= _refiner(dyn,query),
                       cursor= finder.find(query);
                       cursor.chain(refiner);
                       refiner.chain(p);
                   })
                   .error(p.trigger.error);

                });

                p.sort= function (o)
                {
                  modifiers.orderby= o; 
                  return p;
                };

                p.limit= function (n)
                {
                  modifiers.limit= n; 
                  return p;
                };

                p.skip= function (n)
                {
                  modifiers.skip= n; 
                  return p;
                };

                return p;
            };

            table.findOne= function ()
            {
                var p, args= arguments;

                p= dyn.promise('result','notfound');

                table.find.apply(table,args).limit(1).results(function (items)
                {
                     p.trigger.result(items[0]); 
                })
                .error(p.trigger.error);

                return p;
            };

            table.save= function (_obj)
            {
                var obj= _deepclone(_obj), 
                    gops= {},
                    ops= gops[table._dynamo.TableName]= [];

                var _hashrange= function (obj)
                    {
                        obj.$id= obj.$id || uuid();
                        obj.$pos= obj.$pos || 0;
                        obj.$version= (obj.$version || 0)+1;
                    },
                    _index= function (obj)
                    {
                         table.indexes.forEach(function (index)
                         {
                            var iops= index.update(obj) || {};

                            _.keys(iops).forEach(function (table)
                            {
                               var tops= gops[table]= gops[table] || []; 
                               tops.push.apply(tops,iops[table]);
                            });
                         });
                    },
                    _save= function (obj)
                    {
                       var _keys= _.keys(obj),
                           diffs= diff(obj.$old || {},_.omit(obj,'$old'));

                       if ((obj.$id&&_keys.length==1)||!diffs) return;

                       _hashrange(obj);
                       _index(obj);

                       _keys.forEach(function (key)
                       {
                            var type= typeof obj[key];

                            if (type=='object'&&key!='$old')
                            {
                               var desc= obj[key];

                               if (Array.isArray(desc))
                               {
                                   if (desc.length&&typeof desc[0]=='object')
                                   {
                                       var $id= obj['$$$'+key]= obj['$$$'+key] || uuid();

                                       desc.forEach(function (val, pos)
                                       {
                                          if (val.$id&&val.$id!=$id)
                                          {
                                             _save(val);
                                             val.$ref= val.$id;
                                          }

                                          val.$id= $id;
                                          val.$pos= pos;
                                          _save(val);
                                       });

                                       delete obj[key];
                                   }
                               }
                               else
                               {
                                   _save(desc);
                                   obj['$$'+key]= desc.$id;
                                   delete obj[key];
                               }
                            } 
                            else
                            if (type=='string'&&!obj[key])
                              delete obj[key];
                       });

                       ops.push({ op: 'put', item: obj });
                    },
                    _mput= function (gops,done)
                    {
                       async.forEach(_.keys(gops),
                       function (_table,done)
                       {
                          var tops= gops[_table];

                          async.forEach(tops,
                          function (op,done)
                          {
                             var tab= dyn.table(table._dynamo.TableName),
                                 obj= op.item;
                               
                             if (obj.$id!==undefined)
                               tab.hash('$id',obj.$id)
                                  .range('$pos',obj.$pos);
                             else
                             if (obj.$hash!==undefined)
                               tab.hash('$hash',obj.$hash)
                                  .range('$range',obj.$range);
                             else
                             {
                                done(new Error('unknown record type'));
                                return;
                             }

                             if (op.op=='put')
                                 tab.put(_.omit(obj,['$old']),
                                  done,
                                  { expected: obj.$old ? { $version: obj.$old.$version } : undefined })
                                  .error(done);
                             else
                             if (op.op=='del')
                                 tab.delete(done)
                                 .error(done);
                             else
                               done(new Error('unknown update type:'+op.op));
                          },
                          done);
                       },
                       done);
                    };

                var p= dyn.promise([],'updatedsinceread'), found= false;

                _save(obj);

                _.keys(gops).forEach(function (table)
                {
                    if (gops[table].length==0)
                      delete gops[table];
                    else
                      found= true;
                });

                if (found)
                  _mput(gops,function (err)
                  {
                      if (err)
                      {
                        if (err.code='notfound')
                          p.trigger.updatedsinceread();
                        else
                          p.trigger.error(err);
                      }
                      else
                      {
                        table.findOne({ $id: _obj.$id, $pos: _obj.$pos }).result(function (item)
                        {
                            _.extend(_obj,item);
                            p.trigger.success();
                        });
                      }
                  });
                else
                    process.nextTick(p.trigger.success);

                return p;
            };

            table.ensureIndex= function (fields)
            {
                  var p= dyn.promise();

                  process.nextTick(function ()
                  {
                      var index= _index(dyn,table,fields);

                      if (index)
                        index.ensure(function (err)
                        {
                             if (err)
                               p.trigger.error(err);
                             else
                             {
                               table.indexes.push(index);
                               p.trigger.success();
                             }
                        });
                      else
                        p.trigger.error(new Error('no known index type can index those fields'));
                  });

                  return p;
            };

            table.remove= function ()
            {
                var p= dyn.promise(),
                    _deleteItem= function (obj,done)
                    {
                          async.parallel([
                          function (done)
                          {
                              async.forEach(table.indexes,
                              function (index,done)
                              {
                                   index.remove(obj,done);
                              },done);
                          },
                          function (done)
                          {
                              dyn.table(table._dynamo.TableName)
                                 .hash('$id',obj.$id)
                                 .range('$pos',obj.$pos)
                                 .delete(done)
                                 .error(done);
                          }],
                          done);
                    };

                table.find.apply(table,arguments).results(function (items)
                {
                    async.forEach(items,_deleteItem,
                    function (err)
                    {
                       if (err)
                         p.trigger.error(err); 
                       else
                         p.trigger.success();
                    });
                })
                .error(p.trigger.error);

                return p;
            };

            table.update= function (query,update)
            {
                var p= dyn.promise(),
                    _updateItem= function (item,done)
                    {
                       if (update.$set)
                         table.save(_.extend(item,update.$set))
                              .success(done)
                              .error(done); 
                       else
                       if (update.$unset)
                         table.save(_.omit(item,_.keys(update.$unset)))
                              .success(done)
                              .error(done); 
                       else
                         done(new Error('unknown update type')); 
                    },
                    _updateItems= function (items)
                    {
                       async.forEach(items,_updateItem,p.should('success')); 
                    };


                table.find(query)
                     .results(_updateItems)
                     .error(p.trigger.error);

                return p;
            };

            table.drop= function ()
            {
                var p= dyn.promise(),
                    _alias= function (name)
                    {
                        var alias= name;

                        if (opts.tables)
                        _.keys(opts.tables).every(function (alias)
                        {
                              if (opts.tables[alias]==name)
                              {
                                alias= opts.tables[alias];
                                return false;
                              }
                        });
                        
                        return alias;
                    };

                dyn.deleteTable(table._dynamo.TableName,function (err)
                {
                    if (err)
                      p.trigger.error(err);
                    else
                    {
                      delete db[_alias(table._dynamo.TableName)];
                      p.trigger.success();
                    }
                });

                return p;
            };

            return table;
       },
       configureTables= function (cb)
       {
            var configure= function (tables)
                {
                    async.forEach(Object.keys(tables),
                    function (table,done)
                    {
                          dyn.describeTable(table,function (err,data)
                          {
                              if (!err)
                                db[tables[table]]= configureTable({ _dynamo: data.Table, indexes: [] });

                              done(err);
                          });
                    },
                    function (err)
                    {
                       cb(err,err ? null : db);          
                    });
                };

             if (opts.tables)
               configure(opts.tables);
             else
               dyn.listTables(function (err,list)
               {
                   if (err)
                     cb(err);
                   else
                   {
                       var tables= {};
                       list.forEach(function (table) { tables[table]= table; });
                       configure(tables);
                   }
               });
       };

   db.createCollection= function (name)
   { 
      var p= dyn.promise(),
          _success= function ()
          {
              dyn.describeTable(name,function (err,data)
              {
                  if (!err)
                  {
                    db[name]= configureTable({ _dynamo: data.Table, indexes: [] });
                    p.trigger.success();
                  }
                  else
                    p.trigger.error(err);

              });
          };

        dyn.table(name)
           .hash('$id','S')
           .range('$pos','N')
           .create(function check()
           {
              dyn.table(name)
                 .hash('$id','xx')
                 .query(function ()
              {
                 _success();
              })
              .error(function (err)
              {
                 if (err.code=='ResourceNotFoundException')
                   setTimeout(check,5000);
                 else
                 if (err.code=='notfound')
                   _success();
                 else
                   p.trigger.error(err);
              });
           })
           .error(function (err)
           {
               if (err.code=='ResourceInUseException')
                 p.trigger.error(new Error('the collection exists'));
               else
                 p.trigger.error(err);
           });

      return p;
   };

   configureTables(cb);

};
